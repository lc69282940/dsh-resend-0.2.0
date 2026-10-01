/**
 * dsh-resend — the pure part of the host half.
 *
 * Kept import-free and side-effect-free so the logic that decides *what gets
 * replaced* can be exercised with synthetic sessions without booting DSH
 * (see test/host-repair.test.mjs). The host contracts themselves are asserted
 * against an explicitly selected, verified runtime fixture.
 */

/** Released type of the log-only shadow-price claim. */
export const AUDIT_EVENT_TYPE = 'compaction/prune'
/** Released type that actually replaces a surface range. */
export const CARRIER_EVENT_TYPE = 'user/message'
/** `source.kind` the carrier must carry — anything else re-splits the rounds. */
export const CARRIER_SOURCE_KIND = 'model'

/** The session's event log, seq-indexed. New host API first, legacy array second. */
export function sessionEvents(session) {
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
export function eventAt(session, seq) {
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

/** Next append position (`max(seq) + 1`, seq-less entries counted positionally). */
export function nextAppendSeq(session) {
  if (Number.isSafeInteger(session?.seq) && session.seq >= 0) return session.seq
  let expected = 0
  for (const event of sessionEvents(session)) {
    const seq = Number.isSafeInteger(event?.seq) ? event.seq : expected
    if (seq + 1 > expected) expected = seq + 1
  }
  return expected
}

/** The current model surface's node seqs, in position order. */
export function surfaceNodes(session) {
  const nodes = session?.surface?.nodes
  return Array.isArray(nodes) ? nodes.filter((seq) => Number.isSafeInteger(seq)) : []
}

/**
 * Whether `seqs` is exactly a contiguous run of `nodes`.
 *
 * The session migration applies this same check to an audit segment
 * (`isDeepStrictEqual(nodes.slice(a, b + 1), seqs)`). Asserting it before writing
 * is what makes an orphan audit segment impossible: a span that is not an exact
 * slice must never reach the log.
 */
export function isExactSurfaceSpan(nodes, seqs) {
  if (!Array.isArray(nodes) || !Array.isArray(seqs) || seqs.length === 0) return false
  const start = nodes.indexOf(seqs[0])
  if (start < 0 || start + seqs.length > nodes.length) return false
  for (let offset = 0; offset < seqs.length; offset++) {
    if (nodes[start + offset] !== seqs[offset]) return false
  }
  return true
}

/**
 * The round containing `targetSeq`, taken as an exact slice of the CURRENT
 * surface.
 *
 * This is the shape the runtime validates. Deriving the round from the event log
 * instead looks equivalent and is not: the log keeps events the surface has
 * already had replaced, so the two diverge the moment any replacement has
 * happened — and a span that is not an exact current-surface slice is rejected
 * by the v3→v4 migration as session corruption.
 *
 * @param nodes - current surface node seqs, in position order
 * @param targetSeq - a seq that must be present on the surface
 * @param isBoundary - true for a node that opens a round (a real user input)
 * @param isRoundPayload - optional predicate excluding trailing runtime injections
 * @returns {{start:number,end:number,shadowedSeqs:number[]}|null}
 */
export function roundSpanOnSurface(nodes, targetSeq, isBoundary, isRoundPayload = () => true) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const position = nodes.indexOf(targetSeq)
  if (position < 0) return null

  let startIndex = -1
  for (let i = position; i >= 0; i--) {
    if (isBoundary(nodes[i])) {
      startIndex = i
      break
    }
  }
  if (startIndex < 0) return null

  let endIndex = nodes.length - 1
  for (let i = startIndex + 1; i < nodes.length; i++) {
    if (isBoundary(nodes[i])) {
      endIndex = i - 1
      break
    }
  }
  while (endIndex > startIndex && !isRoundPayload(nodes[endIndex])) endIndex -= 1
  if (endIndex < startIndex || position > endIndex) return null

  const shadowedSeqs = nodes.slice(startIndex, endIndex + 1)
  if (shadowedSeqs.length === 0) return null
  if (!isExactSurfaceSpan(nodes, shadowedSeqs)) return null
  return {
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
  }
}

/**
 * A real user input is the only thing that opens a round. The runtime also
 * appends `user/message` for injected context and steering
 * (`source.kind !== 'user'`); treating those as boundaries would move the start
 * of every round.
 */
export const isRoundBoundaryEvent = (event) =>
  event?.type === 'user/message' && event?.data?.source?.kind === 'user'

/** Text blocks of a user/assistant payload joined into one string. */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** Locate a user/assistant message's durable seq by its stable message id. */
export function findMessageSeq(session, messageId) {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const id = event?.type === 'user/message'
      ? event.data?.id
      : event?.type === 'assistant/message'
        ? event.data?.message?.id
        : undefined
    if (typeof id === 'string' && id === messageId) return event.seq
  }
  return -1
}

/**
 * Log position of an event.
 *
 * The seq-indexed view has holes — a 846-event log can run to seq 844 — so a
 * seq is *not* usable as an array index (measured against real logs: the naive
 * `events[seq]` read returned a `system/message` for a user input's seq and the
 * round walk then started at the wrong message). Always resolve position by
 * scanning for the seq.
 *
 * `surfaceNodes` is the last resort: it may be incomplete for compacted
 * sessions, but it is better than no position at all.
 */
export function positionOfSeq(session, seq) {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.seq === seq) return i
  }
  return surfaceNodes(session).indexOf(seq)
}

/**
 * Position of the user input opening the round that contains `index`.
 * The scan starts *at* the target and never wanders below it: dropping below
 * would adopt an earlier input as the round head and re-send the wrong text.
 */
export function roundStartIndex(events, index) {
  for (let i = Math.min(index, events.length - 1); i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if (isRoundBoundaryEvent(event)) return i
  }
  return -1
}

/** Position of the last event in the round whose head is at `index`. */
export function roundEndIndex(events, index) {
  for (let i = index + 1; i < events.length; i++) {
    const event = events[i]
    if (event === undefined) continue
    if (isRoundBoundaryEvent(event)) return i - 1
  }
  return events.length - 1
}

/**
 * Contiguous run of seqs actually present in the log, from `startSeq` forward.
 * A hole ends the run: the replacement must cover exactly the nodes it claims,
 * and claiming a node that is not there is rejected by the surface contract.
 */
export function contiguousSeqs(session, startSeq, endSeq) {
  const seqs = []
  for (let seq = startSeq; seq <= endSeq; seq++) {
    if (eventAt(session, seq) === undefined) break
    seqs.push(seq)
  }
  return seqs
}

/**
 * Position of the last node that belongs to the round's model-visible payload.
 *
 * A round's *log* tail is usually bookkeeping — `agent/inbox/spliced`,
 * `step/start`, `compaction/end` and friends (all observed sitting at real
 * round ends), and the runtime also appends `user/message` nodes for injected
 * context and steering. Measured against real logs, treating either as the
 * range end produced spans ending on an injected message, which would shadow
 * stateless runtime injection along with the round.
 *
 * The range therefore stops at the last `assistant/message`, `tool/result`, or
 * genuine user input.
 */
export function lastRoundNodePosition(events, index) {
  for (let i = index; i >= 0; i--) {
    const event = events[i]
    const type = event?.type
    if (type === 'assistant/message' || type === 'tool/result') return i
    if (isRoundBoundaryEvent(event)) return i
  }
  return -1
}

/**
 * The shadow range for the round containing `targetSeq`:
 * [user input .. last round node before the next input].
 * @returns {{start:number,end:number,shadowedSeqs:number[]}|null}
 */
export function roundSpanOfSeq(session, targetSeq) {
  const events = sessionEvents(session)
  const position = positionOfSeq(session, targetSeq)
  if (position < 0) return null
  const startIndex = roundStartIndex(events, position)
  if (startIndex < 0) return null
  const rawEnd = roundEndIndex(events, startIndex)
  if (rawEnd < startIndex) return null
  const endIndex = lastRoundNodePosition(events, rawEnd)
  if (endIndex < startIndex) return null
  const start = events[startIndex]?.seq
  const end = events[endIndex]?.seq
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null
  const shadowedSeqs = contiguousSeqs(session, start, end)
  if (shadowedSeqs.length === 0) return null
  if (shadowedSeqs[shadowedSeqs.length - 1] !== end) return null
  return { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }
}

/** The user input that opens the round containing `targetSeq`, or -1. */
export function roundPromptSeq(session, targetSeq) {
  const events = sessionEvents(session)
  const position = positionOfSeq(session, targetSeq)
  if (position < 0) return -1
  const startIndex = roundStartIndex(events, position)
  if (startIndex < 0) return -1
  return events[startIndex]?.seq ?? -1
}

