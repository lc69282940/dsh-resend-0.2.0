/**
 * dsh-resend — host half.
 *
 * Adds two operations the stock chat surface lacks:
 *   • regenerate      — replace one assistant reply in place (rewind its round,
 *                       re-send the prompt that produced it);
 *   • editAndResend   — replace one user message and immediately re-run the turn.
 *
 * Why this is a host plugin and not a client-only one: the DSH session log is
 * append-only. "Replacing" a turn means appending a *replacement* node that
 * shadows the old range on the model surface — and then, crucially, the agent
 * must be told to run again. Only the host half can reach `agent.followup()`.
 *
 * The two-segment shadow shape below is the one DSH's own compaction producers
 * use (`compaction/prune` shadow-price claim immediately followed by the
 * replacement `user/message`); it is validated by `session.append` against the
 * canonical surface contract before anything reaches the log. Every shape
 * constant here was read off the running build, not guessed:
 *
 *   - event vocabulary   : @deepseek-ai/dsh-session  SURFACE_EVENT_TYPES / released types
 *   - surfaceOp keys     : {op:'replace',start,end} on format v0, {op:'replace',startSeq,endSeq} on v3
 *                          (exactly three keys either way — the runtime rejects mixed shapes)
 *   - round boundary     : user/message whose data.source.kind === 'user'
 *                          (injected context also appends user/message and must NOT split a round)
 *   - carry source kind  : 'model' — a carrier written as 'user' would be read as a real user
 *                          turn and shift every later round boundary
 */

/** Route prefix registered on the web server. */
export const ROUTE_PREFIX = '/api/plugins/resend'

/** Text left in the model context in place of a shadowed range. */
const TRACE_TEXT = '（此轮对话已被重新生成／编辑替换：旧内容已从模型上下文中移除）'

const MAX_BODY_BYTES = 256 * 1024

import {
  AUDIT_EVENT_TYPE,
  CARRIER_EVENT_TYPE,
  CARRIER_SOURCE_KIND,
  isRoundBoundaryEvent,
  eventAt,
  sessionEvents,
  nextAppendSeq,
  findMessageSeq,
  positionOfSeq,
  extractText,
  roundSpanOnSurface,
  surfaceNodes,
  isExactSurfaceSpan,
} from './host-core.js'
import { isMap } from 'node:util/types'
import { breadcrumb } from './breadcrumb.js'
import { modelSourceFor } from './model-source.js'
import { replaceSurfaceOp, sessionRuntime, spanRangeOf } from './session-surface.js'

// The released V4 contract forbids sourceEventSeqs on assistant/message, while
// every replacement must cite its old nodes. A reply edit therefore uses a
// lawful model-sourced user/message carrier, explicitly labelled as edited
// assistant text. Never forge a provider stream or silently change the role.
const EDIT_REPLY_PREFIX = '【用户编辑后的助手回复；替代原回复，不是新的用户提问】\n'
const EDIT_REPLY_ID = /^resend-marker-edit-reply-(\d+)-(\d+)$/
const inFlight = new WeakSet()

function replyEditOf(event) {
  const match = EDIT_REPLY_ID.exec(String(event?.data?.id ?? ''))
  const range = spanRangeOf(event?.surfaceOp)
  const content = event?.data?.content
  if (event?.type !== CARRIER_EVENT_TYPE || event.data?.source?.kind !== CARRIER_SOURCE_KIND
    || match === null || range === null || range.start !== range.end
    || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))
    || Number(match[1]) >= event.seq || Number(match[2]) !== event.seq - 1
    || !Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length !== 2
    || event.sourceEventSeqs[0] !== Number(match[2]) || event.sourceEventSeqs[1] !== range.start
    || !Array.isArray(content) || content.length !== 2
    || content[0]?.type !== 'text' || content[0].text !== EDIT_REPLY_PREFIX
    || content[1]?.type !== 'text' || typeof content[1].text !== 'string') return null
  return { targetSeq: Number(match[1]), auditSeq: Number(match[2]), text: content[1].text }
}

/**
 * How long to wait for a cancelled reply to settle before giving up. Bounded on
 * purpose: an unbounded wait turns into an HTTP request that never answers, and
 * a never-answering request is what leaves the GUI's composer stuck in its busy
 * state with no way back.
 */
const STOP_WAIT_MS = 20_000

/**
 * Stop a running reply, the same way the UI stop button does, and wait for a
 * clean turn boundary. Editing mid-step would fold the open step into the next
 * assistant message and break the token meter (measured, not theoretical).
 *
 * @param agent - live agent, or undefined
 * @param wait - bounded waiter `(promise, ms, code, message) => Promise`
 */
async function ensureIdle(agent, wait) {
  if (!agent || typeof agent.status !== 'string' || agent.status !== 'running') return
  if (typeof agent.cancel === 'function' && typeof agent.whenIdle === 'function') {
    agent.cancel({ kind: 'user' })
    await wait(
      agent.whenIdle(),
      STOP_WAIT_MS,
      'agent-stop-timeout',
      '已请求停止当前回复，但等它收尾超时了。请确认界面已经停下，再试一次。',
    )
    return
  }
  throw opError('agent-busy', '正在回复中：请先停止当前回复，再执行该操作。')
}

/** Business error carrying a stable code across the wire. */
function opError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Price the exact replaced nodes with the official meter; never invent zero. */
function shadowPrice(ctx, session, seqs) {
  const meter = ctx.get?.('tokenMeter') ?? ctx.tokenMeter
  try {
    const nodes = meter?.measure?.(session)?.nodes
    if (Array.isArray(nodes)) {
      const bySeq = new Map(nodes.map((node) => [node?.seq, node?.tokens]))
      const values = seqs.map((seq) => bySeq.get(seq))
      const total = values.reduce((sum, value) => sum + value, 0)
      if (values.every((value) => Number.isSafeInteger(value) && value >= 0)
        && Number.isSafeInteger(total)) return total
    }
  } catch { /* report one stable, pre-write failure below */ }
  throw opError('meter-unavailable', '无法取得要替换内容的官方令牌计量，已中止（未写入任何内容）。')
}

/**
 * Validate the whole prospective pair before touching the log. Event-local
 * adoption alone cannot validate positional replacement or the disk vocabulary.
 * The runtime fold and released V4 codec cover those independent contracts.
 */
function planShadowMarker(ctx, session, span, runtime, edit = null) {
  const model = modelSourceFor(session, span.end)
  if (!model) throw opError('no-model-source', '找不到合法模型来源，已中止（未写入任何内容）。')
  const shadowed = [...span.shadowedSeqs]
  if (shadowed[0] !== span.start || shadowed.at(-1) !== span.end) {
    throw opError('bad-span', '遮蔽区间与节点列表不一致，已中止（未写入任何内容）。')
  }
  if (!isExactSurfaceSpan(surfaceNodes(session), shadowed)) {
    throw opError('span-not-on-surface', '目标已被替换或不在当前模型表面，已中止（未写入任何内容）。')
  }
  const auditSeq = nextAppendSeq(session)
  const time = Date.now()
  const audit = {
    seq: auditSeq, time, type: AUDIT_EVENT_TYPE,
    data: {
      shadowedRange: { start: span.start, end: span.end },
      shadowedSeqs: shadowed,
      shadowedTokenCount: shadowPrice(ctx, session, shadowed),
    },
  }
  const carrier = {
    seq: auditSeq + 1, time, type: CARRIER_EVENT_TYPE,
    data: {
      role: 'user',
      id: edit === null ? `resend-marker-${auditSeq}` : `resend-marker-edit-reply-${edit.targetSeq}-${auditSeq}`,
      content: edit === null
        ? [{ type: 'text', text: TRACE_TEXT }]
        : [{ type: 'text', text: EDIT_REPLY_PREFIX }, { type: 'text', text: edit.text }],
      source: { kind: CARRIER_SOURCE_KIND, provider: model.provider, model: model.model },
    },
    surfaceOp: replaceSurfaceOp(span.start, span.end, runtime.SESSION_FORMAT_VERSION),
    sourceEventSeqs: [auditSeq, ...shadowed],
  }
  try {
    runtime.validateEvent(audit)
    runtime.validateEvent(carrier)
    runtime.foldSurface([...sessionEvents(session), audit, carrier], ctx.sessions?.messageProjections ?? [])
  } catch (error) {
    throw opError('carrier-rejected', `运行时拒绝了替换计划，未写入任何内容：${String(error?.message ?? error)}`)
  }
  return { span, shadowed, audit, carrier }
}

/** Commit a validated pair synchronously: no async gap and no stale seq guess. */
function writeShadowMarker(session, plan) {
  const { audit, carrier, shadowed } = plan
  if (nextAppendSeq(session) !== audit.seq || !isExactSurfaceSpan(surfaceNodes(session), shadowed)) {
    throw opError('session-changed', '会话在校验后发生变化，未写入任何内容，请重试。')
  }
  const writtenAudit = session.append(audit.type, audit.data)
  const written = session.append(carrier.type, carrier.data, {
    surfaceOp: carrier.surfaceOp,
    sourceEventSeqs: carrier.sourceEventSeqs,
  })
  if (writtenAudit?.seq !== audit.seq || written?.seq !== writtenAudit.seq + 1) {
    throw opError('marker-pair-unpaired', '宿主未按顺序写入替换记录，请停止操作并检查会话日志。')
  }
  return written
}

/** The message queued to re-run a turn (`agent.followup` takes one message). */
function followup(text) {
  const stamp = Date.now().toString(36)
  return {
    id: `resend-${stamp}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `dsh-resend-${stamp}` },
  }
}

/**
 * Build the host handler.
 * @param ctx - plugin context carrying `sessions`, `agents` and `logger`.
 */
export function createResendHandler(ctx) {
  const sessions = ctx.sessions
  const agents = ctx.agents

  const requireSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw opError('bad-request', 'sessionId 必填。')
    }
    const session = sessions?.get?.(sessionId)
    if (!session) throw opError('session-not-found', `找不到会话 ${sessionId}。`)
    return session
  }

  const requireAgent = (sessionId) => {
    const agent = agents?.get?.(sessionId)
    if (!agent || typeof agent.followup !== 'function') {
      throw opError('agent-unavailable', '这个会话没有活跃的 agent，无法重新发送。')
    }
    return agent
  }

  /**
   * Wait for a promise, but never forever.
   *
   * `agent.whenIdle()` after a cancel has no built-in bound, and an HTTP request
   * that never settles is what makes the GUI's composer look dead: the client's
   * own stop/send bookkeeping stays in its "busy" state with nothing left to
   * drive it. A bounded wait always answers, so the caller can give up cleanly.
   */
  const withTimeout = (promise, ms, code, message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(opError(code, message)), ms)
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })

  /**
   * The message a structural node belongs to.
   *
   * In the transcript, the action strip of an assistant turn hangs off the
   * turn's *tail*, whose node seq is a structural event (`turn/end`,
   * `session/title`, `step/end`, …) rather than the reply itself. Measured on a
   * real click: the client handed over seq 22, which was `turn/end`, and the
   * operation was refused with "not a user message or assistant reply".
   *
   * So a seq is never required to *be* a message — it only has to sit in the
   * right round. The scan walks back to the nearest message, stopping at the
   * round's user input for anything that turns out to be a later structural
   * node. A message seq short-circuits immediately, so the common case is one
   * lookup.
   */
  const messageAtOrBefore = (session, seq) => {
    const events = sessionEvents(session)
    const start = positionOfSeq(session, seq)
    if (start < 0) return undefined
    for (let i = start; i >= 0 && start - i <= 64; i--) {
      const event = events[i]
      if (event === undefined) continue
      if (event.type === 'assistant/message') return event
      if (event.type === 'user/message') {
        // A real user input is the round head: never resolve past it, or the
        // click resolves to the previous turn's prompt.
        if (isRoundBoundaryEvent(event)) return event
        continue
      }
    }
    return undefined
  }

  /**
   * Resolve the clicked row to a durable message.
   *
   * Both hints the client can send are unreliable alone, and each has produced a
   * real failure:
   *   - `seq` may name a structural node (the turn tail), not a message;
   *   - `messageId` comes from a React fiber walk that can settle on an
   *     ancestor, so an assistant row can resolve to a *user* message.
   * A candidate is therefore accepted only when it actually resolves to a
   * user/assistant message, and the seq is preferred because it is bound to the
   * row the user clicked.
   *
   * @returns {{seq:number, kind:string, text:string, source:'seq'|'messageId', nodeType?:string}}
   */
  const currentReply = (session, original) => {
    let current = original
    for (const event of sessionEvents(session)) {
      const edit = replyEditOf(event)
      if (edit?.targetSeq === original.seq && spanRangeOf(event.surfaceOp)?.start === current.seq) current = event
    }
    return current
  }

  const resolveTarget = (session, { messageId, seq }) => {
    const describe = (event, source, nodeType) => {
      const edit = replyEditOf(event)
      const original = edit === null ? event : eventAt(session, edit.targetSeq)
      if (!original || (edit !== null && original.type !== 'assistant/message')) {
        throw opError('message-not-found', '编辑记录指向的原回复不存在。')
      }
      const current = original.type === 'assistant/message' ? currentReply(session, original) : original
      return {
        seq: original.seq,
        surfaceSeq: current.seq,
        messageId: original.type === 'user/message' ? original.data?.id : original.data?.message?.id,
        kind: original.type,
        text: replyEditOf(current)?.text ?? extractText(original.type === 'user/message' ? original.data?.content : original.data?.message?.content),
        source,
        nodeType,
      }
    }

    if (Number.isSafeInteger(seq) && seq >= 0) {
      const direct = eventAt(session, seq)
      const found = direct !== undefined && (direct.type === 'user/message' || direct.type === 'assistant/message')
        ? direct
        : messageAtOrBefore(session, seq)
      if (found !== undefined) {
        return describe(found, 'seq', direct !== found ? direct?.type : undefined)
      }
    }
    if (typeof messageId === 'string' && messageId.length > 0) {
      const found = findMessageSeq(session, messageId)
      if (found === -1) throw opError('message-not-found', '在这个会话里找不到这条消息。')
      const event = eventAt(session, found)
      if (event === undefined) throw opError('message-not-found', '在这个会话里找不到这条消息。')
      return describe(event, 'messageId')
    }
    if (Number.isSafeInteger(seq) && seq >= 0) {
      const lastSeq = sessionEvents(session).at(-1)?.seq
      if (Number.isSafeInteger(lastSeq) && seq > lastSeq) {
        throw opError('message-not-found',
          `seq ${seq} 超出了这个会话的日志范围（最大 ${lastSeq}）。`)
      }
      throw opError(
        'not-a-message',
        `seq ${seq} 附近找不到任何消息（它本身是 ${eventAt(session, seq)?.type ?? '未知类型'}）。`,
      )
    }
    throw opError('bad-request', '缺少定位信息（messageId 或 seq）。')
  }

  /** Refuse a mismatched target, naming what was actually found. */
  const requireKind = (target, wanted, request, code) => {
    if (target.kind === wanted) return
    throw opError(
      code,
      `${request}需要一条${wanted === 'assistant/message' ? '助手回复' : '你自己的消息'}，` +
        `但 seq ${target.seq} 是一条${target.kind === 'assistant/message' ? '助手回复' : '用户消息'}` +
        `（定位方式：${target.source}）。`,
    )
  }

  /** Exact current-surface round only. Missing/compacted history is read-only. */
  const spanForTarget = (session, targetSeq) => {
    const nodes = surfaceNodes(session)
    const onSurface = roundSpanOnSurface(nodes, targetSeq,
      (seq) => isRoundBoundaryEvent(eventAt(session, seq)),
      (seq) => {
        const event = eventAt(session, seq)
        return isRoundBoundaryEvent(event) || event?.type === 'assistant/message'
          || event?.type === 'tool/result' || replyEditOf(event) !== null
      })
    if (onSurface !== null) return onSurface
    throw opError('span-not-on-surface', '目标不在当前模型表面的有效轮次中（可能已被替换或压缩），未写入任何内容。')
  }

  /**
   * Re-run one round in place: shadow [round start .. round end], then send the
   * replacement text as a fresh turn.
   *
   * Everything that can fail on its own terms — resolving the round, finding the
   * model to name, validating the marker against the runtime — happens BEFORE the
   * agent is touched. Cancelling a live reply and then refusing the operation
   * would leave the user with a stopped turn and an unexplained error.
   */
  async function flushWritten(session) {
    try {
      if (typeof sessions.flush === 'function') await withTimeout(
        sessions.flush(session), STOP_WAIT_MS, 'flush-timeout', '持久化等待超过 20 秒。',
      )
    } catch (error) {
      throw opError('flush-failed', '替换已写入内存，但持久化失败；未继续重发。请不要重复点击，先检查会话保存状态。' + String(error?.message ?? error))
    }
  }

  async function replaceRound(session, agent, targetSeq, text) {
    const runtime = await sessionRuntime()
    // Preflight every independent failure before stopping a live turn.
    planShadowMarker(ctx, session, spanForTarget(session, targetSeq), runtime)
    await ensureIdle(agent, withTimeout)
    // Cancellation can append a settled assistant message and structural tail.
    // Re-resolve and validate after the await, not with a pre-cancel seq/span.
    const span = spanForTarget(session, targetSeq)
    const plan = planShadowMarker(ctx, session, span, runtime)
    const carrier = writeShadowMarker(session, plan)
    await flushWritten(session)
    try {
      await agent.followup(followup(text))
    } catch (error) {
      throw opError('followup-failed', '旧轮已替换，但重发失败；请手动发送提问，不要重复操作旧消息。' + String(error?.message ?? error))
    }
    return {
      shadowed: span.shadowedSeqs.length,
      start: span.start, end: span.end,
      targetSeq, auditSeq: plan.audit.seq, replacementSeq: carrier.seq,
      formatVersion: runtime.SESSION_FORMAT_VERSION,
    }
  }

  /** Re-run one round from the target's own prompt. */
  async function runFromTarget(sessionId, target) {
    const session = requireSession(sessionId)
    const agent = requireAgent(sessionId)
    if (target.kind === 'assistant/message') {
      const promptSeq = spanForTarget(session, target.surfaceSeq).start
      const prompt = extractText(eventAt(session, promptSeq)?.data?.content)
      if (prompt.trim().length === 0) throw opError('no-text', '原提问没有可重发的文本内容。')
      return replaceRound(session, agent, target.surfaceSeq, prompt)
    }
    if (target.text.trim().length === 0) throw opError('no-text', '这条消息没有可重发的文本内容。')
    return replaceRound(session, agent, target.surfaceSeq, target.text)
  }

  /** Regenerate a reply in place (assistant reply, or the whole round of a user message). */
  async function regenerate(sessionId, target) {
    requireKind(target, 'assistant/message', '「重新生成」', 'not-assistant-message')
    return runFromTarget(sessionId, target)
  }

  /** Re-run the turn of a user message without changing its text. */
  async function regenerateFromPrompt(sessionId, target) {
    const session = requireSession(sessionId)
    requireKind(target, 'user/message', '按原样重新生成', 'not-user-message')
    if (!isRoundBoundaryEvent(eventAt(session, target.seq))) {
      throw opError('not-user-message', `seq ${target.seq} 不是一条真实的用户输入（可能是注入的上下文）。`)
    }
    return runFromTarget(sessionId, target)
  }

  /** Rewrite a user message and immediately re-run the turn with the new text. */
  async function editAndResend(sessionId, target, text) {
    const session = requireSession(sessionId)
    requireKind(target, 'user/message', '编辑重发', 'not-user-message')
    if (!isRoundBoundaryEvent(eventAt(session, target.seq))) {
      throw opError('not-user-message', `seq ${target.seq} 不是一条真实的用户输入（可能是注入的上下文）。`)
    }
    const next = typeof text === 'string' ? text : ''
    if (next.trim().length === 0) throw opError('blank-text', '编辑后的内容不能为空。')
    return replaceRound(session, requireAgent(sessionId), target.surfaceSeq, next)
  }

  /**
   * Rewrite an assistant reply's content WITHOUT sending anything.
   *
   * Editing a reply and re-running are different wishes. Re-running is for "ask
   * again"; this operation is for "the context I keep should say this instead",
   * and the change takes effect on the next message that is sent — there is
   * nothing to answer now, so nothing is queued.
   *
   * The replacement still goes through the same marker pair as every other
   * rewrite: the reply's own node is taken off the model surface and replaced by
   * the edited text. No agent is needed, so a reply can be edited in a session
   * whose agent is idle without waking it.
   */
  async function editReply(sessionId, target, text) {
    const session = requireSession(sessionId)
    requireKind(target, 'assistant/message', '编辑回复', 'not-assistant-message')
    const next = typeof text === 'string' ? text : ''
    if (next.trim().length === 0) throw opError('blank-text', '编辑后的内容不能为空。')
    // Replacing a tool-call-bearing assistant node would leave dangling tool
    // results. Editing plain reply text must never sever that relationship.
    const original = eventAt(session, target.seq)
    if (original?.data?.message?.content?.some((block) => block?.type === 'tool-call')) {
      throw opError('tool-call-reply', '这条助手消息包含工具调用，不能只替换文本；请选择最终的纯文本回复。')
    }
    const agent = agents?.get?.(sessionId)
    if (agent?.status === 'running') throw opError('agent-busy', '助手正在回复中，请先停止再编辑；本操作不会自动停止或重发。')
    const runtime = await sessionRuntime()
    if (agent?.status === 'running') throw opError('agent-busy', '助手已开始回复，未保存修改，请先停止再编辑。')
    const current = currentReply(session, original)
    const span = { start: current.seq, end: current.seq, shadowedSeqs: [current.seq] }
    const plan = planShadowMarker(ctx, session, span, runtime, { targetSeq: target.seq, text: next })
    const carrier = writeShadowMarker(session, plan)
    await flushWritten(session)
    return {
      replaced: 1, start: span.start, end: span.end, resent: false,
      targetSeq: target.seq, auditSeq: plan.audit.seq, replacementSeq: carrier.seq,
      editedText: next, contextRole: 'user',
    }
  }

  /** Read canonical message text, including the latest validated reply edit. */
  function inspect(sessionId, target) {
    const session = requireSession(sessionId)
    const kind = target.kind === 'assistant/message' ? 'assistant' : 'user'
    return {
      kind, eventType: target.kind, text: target.text,
      targetSeq: target.seq, surfaceSeq: target.surfaceSeq, messageId: target.messageId,
      active: surfaceNodes(session).includes(target.surfaceSeq),
    }
  }

  /**
   * The shadow ranges this plugin has written to a session, for the view to hide.
   *
   * Read-only. The transcript deliberately renders replacement events — a reader
   * has to be able to see that something was replaced — so the *view* is the only
   * layer that can present "the old round is gone", and it needs this list to do
   * it. Nothing here changes the log.
   */
  function marks(sessionId) {
    // Cosmetic and read-only: a missing or unknown id yields "nothing to hide"
    // rather than an error. Failing here would leave the view un-painted for a
    // reason the user cannot act on, and the failure would surface as a puzzling
    // "bad request" toast for a purely visual feature.
    const session = typeof sessionId === 'string' && sessionId.length > 0
      ? sessions?.get?.(sessionId)
      : undefined
    if (!session) return { ranges: [], markers: [], reason: 'session-unavailable' }
    const ranges = []
    const markers = []
    const activeSeqs = new Set(surfaceNodes(session))
    for (const event of sessionEvents(session)) {
      if (event?.type !== 'user/message') continue
      if (!String(event.data?.id ?? '').startsWith('resend-marker-')) continue
      const range = spanRangeOf(event.surfaceOp)
      if (range === null) continue
      ranges.push([range.start, range.end])
      const edit = replyEditOf(event)
      const cited = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
      const audit = eventAt(session, cited[0])
      const paired = audit?.type === AUDIT_EVENT_TYPE && audit.seq + 1 === event.seq
        && audit.data?.shadowedRange?.start === range.start && audit.data?.shadowedRange?.end === range.end
      const shadowedSeqs = (paired ? audit.data?.shadowedSeqs : cited)
      markers.push({
        kind: edit === null ? 'regenerate' : 'editReply',
        targetSeq: edit?.targetSeq ?? range.start,
        replacementSeq: event.seq,
        ...(paired ? { auditSeq: audit.seq } : {}),
        shadowedSeqs: Array.isArray(shadowedSeqs) ? shadowedSeqs.filter(Number.isSafeInteger) : [],
        start: range.start, end: range.end,
        active: activeSeqs.has(event.seq),
        ...(edit === null ? {} : { editedText: edit.text }),
      })
    }
    return { ranges, markers }
  }

  /** Read-only readiness probe: no session lookup, cancellation or append. */
  async function status() {
    const runtime = await sessionRuntime()
    return { version: 2, sessionFormatVersion: runtime.SESSION_FORMAT_VERSION, runtimeValidated: true }
  }

  const OPERATIONS = { regenerate, regenerateFromPrompt, editAndResend, editReply, marks, inspect, status }

  return async function handle(request, response) {
    const send = (status, value) => {
      const body = JSON.stringify(value)
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      response.end(body)
    }

    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const op = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '').split('/')[0]

      // Client-half breadcrumb sink. Sent by the injected client module as soon
      // as it executes, so "module never injected" and "module ran but matched
      // nothing" are distinguishable from the log alone.
      if (op === 'beacon') {
        const message = String(url.searchParams.get('message') ?? '').slice(0, 300)
        const extra = String(url.searchParams.get('data') ?? '').slice(0, 600)
        breadcrumb('client', message || 'beacon', extra ? { data: extra } : {})
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        response.end()
        return
      }

      const handler = Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op] : undefined
      if (!handler) {
        send(404, { ok: false, error: { code: 'unknown-op', message: `未知操作：${op}` } })
        return
      }

      if (request.method !== 'POST') {
        send(405, { ok: false, error: { code: 'method-not-allowed', message: '此接口仅接受 POST。' } })
        return
      }
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_BODY_BYTES) {
          send(413, { ok: false, error: { code: 'body-too-large', message: '请求体过大。' } })
          return
        }
        chunks.push(buffer)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let args = {}
      if (raw.length > 0) {
        try {
          args = JSON.parse(raw)
        } catch {
          send(400, { ok: false, error: { code: 'bad-json', message: '请求体不是合法 JSON。' } })
          return
        }
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        send(400, { ok: false, error: { code: 'bad-json', message: '请求体必须是 JSON 对象。' } })
        return
      }

      if (op === 'status') {
        send(200, { ok: true, value: await status() })
        return
      }
      const sessionId = String(args.sessionId ?? '')

      // Operations that take a target message resolve it here. `marks` takes only
      // a session — it reports the shadow ranges the view needs to hide replaced
      // rounds. Running it through target resolution rejected it every time
      // ("missing messageId or seq"), so the ranges never arrived and the view
      // never hid anything: the hide feature was dead on arrival while the log
      // looked perfectly healthy.
      const TARGETLESS = new Set(['marks'])
      if (TARGETLESS.has(op)) {
        const value = await handler(sessionId, undefined, args.text)
        breadcrumb('host', `op:${op}`, { session: sessionId.slice(0, 20), ranges: value?.ranges?.length })
        send(200, { ok: true, value })
        return
      }

      const session = requireSession(sessionId)
      const target = resolveTarget(session, {
        messageId: typeof args.messageId === 'string' ? args.messageId : undefined,
        seq: Number.isSafeInteger(args.seq) ? args.seq : undefined,
      })
      if (op === 'inspect') {
        if ((args.kind === 'assistant' && target.kind !== 'assistant/message')
          || (args.kind === 'user' && target.kind !== 'user/message')) {
          throw opError('target-kind-mismatch', '消息类型与点击的行不一致，未进行编辑。')
        }
        send(200, { ok: true, value: inspect(sessionId, target) })
        return
      }
      if (inFlight.has(session)) throw opError('operation-in-progress', '此会话已有编辑或重新生成正在执行，请稍候。')
      // Every mutation is recorded before it runs. Read-only inspect is quiet.
      breadcrumb('host', `op:${op}:begin`, {
        session: sessionId.slice(0, 20),
        seq: target.seq,
        kind: target.kind,
        via: target.source,
        hasMessageId: typeof args.messageId === 'string' && args.messageId.length > 0,
        textLength: typeof args.text === 'string' ? args.text.length : undefined,
      })
      inFlight.add(session)
      try {
        const value = await handler(sessionId, target, args.text)
        breadcrumb('host', `op:${op}:ok`, { seq: target.seq, shadowed: value?.shadowed })
        send(200, { ok: true, value })
      } finally {
        inFlight.delete(session)
      }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const status = code === 'internal' ? 500 : 400
      if (code === 'internal') ctx.logger?.warn(`dsh-resend: ${String(error?.stack ?? error)}`)
      breadcrumb('host', 'op:failed', {
        code,
        message: error instanceof Error ? error.message : String(error),
        stack: code === 'internal' ? String(error?.stack ?? '').slice(0, 700) : undefined,
      })
      send(status, {
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

/** Cordis plugin name. */
export const name = 'dsh-resend'

/** Services this half needs. */
export const inject = ['sessions', 'agents', 'webServer']

/** Install one owned route. Public releases never reclaim any existing route. */
function installRoute(webServer, handler) {
  const table = webServer.prefixes
  if (!isMap(table)) throw opError('route-lifecycle-unavailable', '宿主未提供可核对路由所有权的前缀表，未修改任何路由。')
  if (table.has(ROUTE_PREFIX)) {
    throw opError('route-conflict', '插件路由已被其他或仍受管理的处理器占用，未移除现有路由。')
  }
  const route = { kind: 'prefix', path: ROUTE_PREFIX, handler }
  let dispose
  try {
    dispose = webServer.register(route)
    if (typeof dispose !== 'function' || table.get(ROUTE_PREFIX) !== route) {
      throw new Error('webServer.register did not install the exact owned route with a disposer')
    }
  } catch (error) {
    // Undo only our own partial registration, never an unrelated route.
    if (table.get(ROUTE_PREFIX) === route) table.delete(ROUTE_PREFIX)
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // The host's disposer only deletes by path. Guard it with object identity
    // so a delayed old generation can never remove its successor.
    if (table.get(ROUTE_PREFIX) === route) dispose()
  }
}

/** Mount the route with explicit Cordis lifetime ownership. */
export function apply(ctx) {
  breadcrumb('host', 'apply-enter', {
    version: 2,
    hasSessions: typeof ctx.sessions?.get === 'function',
    hasAgents: typeof ctx.agents?.get === 'function',
  })
  try {
    const handler = createResendHandler(ctx)
    const webServer = ctx.get?.('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn('dsh-resend: webServer service 不可用，HTTP 路由未注册。')
      breadcrumb('host', 'no-web-server', { type: typeof webServer })
      return
    }
    // Ordinary exported functions are constructible. Cordis invokes apply via
    // `new`, so returning a disposer does NOT register it. ctx.effect is required.
    ctx.effect(() => installRoute(webServer, handler), 'dsh-resend: HTTP route')
    ctx.logger?.info(`dsh-resend: ${ROUTE_PREFIX}/* 路由已注册`)
    breadcrumb('host', 'route-registered', { version: 2, prefix: ROUTE_PREFIX, lifecycle: 'ctx.effect' })
  } catch (error) {
    const message = error instanceof Error ? `${error.message}` : String(error)
    ctx.logger?.error?.(`dsh-resend: apply 失败 ${message}`)
    breadcrumb('host', 'apply-failed', {
      error: message,
      stack: error instanceof Error ? String(error.stack).slice(0, 900) : null,
    })
    throw error
  }
}
