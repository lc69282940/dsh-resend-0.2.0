/**
 * dsh-resend — where the carrier's model source comes from.
 *
 * The replacement `user/message` this plugin appends must carry
 * `source: { kind: 'model', provider, model }`, and the released vocabulary
 * demands both strings be non-empty. Which model to name depends on the session:
 * a session that has never sent a request has nothing to name.
 *
 * The shapes below were read off real logs — and reading them wrong cost a whole
 * debugging round. A request header does NOT put provider/model at the top:
 *
 *   { type: 'request/header', data: { header: { config: { provider, model } } } }
 *
 * Looking for `data.model` there made the plugin report "this session has never
 * sent a request" for a session that had two headers, and refuse to work.
 *
 * Sources, most authoritative first:
 *   1. the target reply's own embedded source (`data.message.source`) — the model
 *      that actually produced the turn, already in released shape;
 *   2. the last `request/header` → `data.header.config`;
 *   3. the last `model/selection` → `data`.
 *
 * Kept import-free so it can be exercised with synthetic events without
 * booting anything or reading real logs (see test/model-source.test.mjs).
 */

/** Read a session's event log, new host API first, legacy array second. */
function sessionEvents(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    try {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    } catch {
      /* fall through to the legacy view */
    }
  }
  return Array.isArray(session.events) ? session.events : []
}

/** One event at one exact seq. */
function eventAt(session, seq) {
  if (!session) return undefined
  if (typeof session.eventAt === 'function') {
    try {
      const event = session.eventAt(seq)
      if (event?.seq === seq) return event
    } catch {
      /* fall through */
    }
  }
  return sessionEvents(session).find((event) => event?.seq === seq)
}

/** Narrow a candidate to `{provider, model}` when both are non-empty strings. */
function usable(candidate) {
  const provider = candidate?.provider
  const model = candidate?.model
  if (typeof provider === 'string' && provider.length > 0
    && typeof model === 'string' && model.length > 0) {
    return { provider, model }
  }
  return null
}

/**
 * The provider/model a replacement marker should name.
 * @param session - session-like object
 * @param targetSeq - seq of the message being replaced, when known
 * @returns {{provider:string, model:string, from:string}|null}
 */
export function modelSourceFor(session, targetSeq) {
  if (Number.isSafeInteger(targetSeq)) {
    const target = eventAt(session, targetSeq)
    const embedded = usable(target?.data?.message?.source ?? target?.data?.source)
    if (embedded) return { ...embedded, from: 'assistant-source' }
  }

  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'request/header') continue
    const header = usable(event.data?.header?.config) ?? usable(event.data)
    if (header) return { ...header, from: 'request-header' }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'model/selection') continue
    const selected = usable(event.data)
    if (selected) return { ...selected, from: 'model-selection' }
  }
  return null
}
