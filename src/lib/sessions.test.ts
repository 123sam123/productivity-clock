/**
 * Session tests. Run with `npm test`.
 *
 * Same trick as the engine tests: `now` is an argument, so "the laptop slept
 * through the end of a pomodoro" and "the tab was closed for two hours" are
 * ordinary function calls. scripts/verify-sessions.mjs then proves the same
 * properties hold in a real browser, across a real restart.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MINUTE_MS,
  createTimer,
  pause,
  reset,
  settle,
  skip,
  start,
  type TimerState,
} from './timer.ts'
import {
  MAX_SESSIONS,
  MIN_ABANDONED_MS,
  addSession,
  dayKey,
  deserializeSessions,
  focusedOn,
  formatFocusTime,
  groupByDay,
  parseSessions,
  record,
  sessionFrom,
  serializeSessions,
  type Session,
} from './sessions.ts'

const T0 = 1_700_000_000_000 // fixed epoch; nothing here depends on the real clock
const FOCUS = 25 * MINUTE_MS

/** Record whatever the transition ended, exactly as useTimer does. */
const recorded = (list: Session[], t: { ended: Parameters<typeof record>[1] }) =>
  record(list, t.ended)

// ---------------------------------------------------------------------------
// What becomes a session
// ---------------------------------------------------------------------------

test('a focus block that runs to zero is recorded as completed, for its full length', () => {
  const running = start(createTimer(), T0)
  const t = settle(running, T0 + FOCUS)

  const sessions = recorded([], t)
  assert.equal(sessions.length, 1)

  const [s] = sessions
  assert.equal(s.outcome, 'completed')
  assert.equal(s.startedAt, T0)
  assert.equal(s.endedAt, T0 + FOCUS)
  assert.equal(s.focusedMs, FOCUS)
  assert.equal(s.plannedMs, FOCUS)
  assert.equal(s.taskId, null)
})

test('skipping a focus block mid-flight records what you actually did, as abandoned', () => {
  const running = start(createTimer(), T0)
  const t = skip(running, T0 + 10 * MINUTE_MS)

  const [s] = recorded([], t)
  assert.equal(s.outcome, 'abandoned')
  assert.equal(s.focusedMs, 10 * MINUTE_MS)
  assert.equal(s.plannedMs, FOCUS) // it set out to do 25
  assert.equal(s.endedAt, T0 + 10 * MINUTE_MS)
})

test('resetting a focus block mid-flight abandons it rather than erasing it', () => {
  const running = start(createTimer(), T0)
  const t = reset(running, T0 + 12 * MINUTE_MS)

  const [s] = recorded([], t)
  assert.equal(s.outcome, 'abandoned')
  assert.equal(s.focusedMs, 12 * MINUTE_MS)
  // …and the clock itself is back to a full phase, ready to go again.
  assert.equal(t.state.status, 'idle')
  assert.equal(t.state.phaseTotalMs, FOCUS)
})

test('a phase that never started ends nothing — reset and skip on an untouched clock are silent', () => {
  const idle = createTimer()

  assert.equal(reset(idle, T0).ended, null)
  assert.equal(skip(idle, T0).ended, null)
  assert.deepEqual(recorded([], reset(idle, T0)), [])
  assert.deepEqual(recorded([], skip(idle, T0)), [])
})

test('a start-then-immediately-reset is a false start, not history', () => {
  const running = start(createTimer(), T0)

  // Two seconds in. A misclick, and it must not litter the history list.
  assert.deepEqual(recorded([], reset(running, T0 + 2_000)), [])

  // Just under the floor: still a false start.
  assert.deepEqual(recorded([], skip(running, T0 + MIN_ABANDONED_MS - 1)), [])

  // At the floor: you put real time in, so it counts.
  const [s] = recorded([], skip(running, T0 + MIN_ABANDONED_MS))
  assert.equal(s.outcome, 'abandoned')
  assert.equal(s.focusedMs, MIN_ABANDONED_MS)
})

test('breaks are not sessions — history is a record of focus, not of resting', () => {
  // Run a focus block to completion; the engine lands on the short break.
  const afterFocus = settle(start(createTimer(), T0), T0 + FOCUS)
  assert.equal(afterFocus.state.phase, 'shortBreak')

  const breakRunning = start(afterFocus.state, T0 + FOCUS)
  const breakDone = settle(breakRunning, T0 + FOCUS + 5 * MINUTE_MS)

  // The break DID end — the banner needs to know — but it is not history.
  assert.equal(breakDone.ended?.phase, 'shortBreak')
  assert.equal(breakDone.ended?.outcome, 'completed')
  assert.deepEqual(recorded([], breakDone), [])

  // And skipping a break records nothing either.
  assert.deepEqual(recorded([], skip(breakRunning, T0 + FOCUS + MINUTE_MS)), [])
})

// ---------------------------------------------------------------------------
// The numbers have to be true
// ---------------------------------------------------------------------------

test('pausing does not inflate focus time: an hour on pause is not an hour of focus', () => {
  let t: TimerState = start(createTimer(), T0)
  t = pause(t, T0 + 10 * MINUTE_MS) // 10 min in
  t = start(t, T0 + 70 * MINUTE_MS) // …lunch. Resume an hour later.

  // 15 minutes of clock remained, so it ends 15 minutes after resuming.
  const done = settle(t, T0 + 85 * MINUTE_MS)
  const [s] = recorded([], done)

  assert.equal(s.outcome, 'completed')
  assert.equal(s.focusedMs, FOCUS) // 25 minutes of actual focus…
  assert.equal(s.endedAt - s.startedAt, 85 * MINUTE_MS) // …across 85 minutes of wall clock.
})

test('a block that ends while the machine sleeps is dated when it truly ended, not when we noticed', () => {
  const running = start(createTimer(), T0)

  // Lid shut at minute 5. Opened three hours later. The deadline passed at
  // T0+25min, unwitnessed.
  const onWake = settle(running, T0 + 3 * 60 * MINUTE_MS)
  const [s] = recorded([], onWake)

  assert.equal(s.outcome, 'completed')
  assert.equal(s.endedAt, T0 + FOCUS) // NOT T0 + 3h
  assert.equal(s.focusedMs, FOCUS)
})

test('sleeping through the afternoon does not invent sessions nobody worked', () => {
  const running = start(createTimer(), T0)

  // One focus block completes; we land idle on a break and stay there.
  let sessions = recorded([], settle(running, T0 + 8 * 60 * MINUTE_MS))
  assert.equal(sessions.length, 1)

  // Eight more hours pass with the clock idle. An idle phase has no deadline to
  // trip, so there is nothing to settle and nothing to record.
  const stillIdle = settle(createTimer(), T0 + 16 * 60 * MINUTE_MS)
  sessions = recorded(sessions, stillIdle)
  assert.equal(sessions.length, 1)
})

// ---------------------------------------------------------------------------
// Recording is idempotent — the property useTimer leans on
// ---------------------------------------------------------------------------

test('recording the same phase-end twice yields one session, not two', () => {
  const done = settle(start(createTimer(), T0), T0 + FOCUS)

  const once = recorded([], done)
  const twice = recorded(once, done) // StrictMode double-invoke, a settle() race — same thing.

  assert.equal(twice.length, 1)
  assert.equal(twice, once, 'a no-op add must be identity-stable, or React re-renders for nothing')
})

test('two blocks that start at the same instant cannot exist, so ids never collide', () => {
  const a = sessionFrom(settle(start(createTimer(), T0), T0 + FOCUS).ended!)
  const b = sessionFrom(settle(start(createTimer(), T0 + FOCUS), T0 + 2 * FOCUS).ended!)

  assert.notEqual(a.id, b.id)
  assert.equal(addSession(addSession([], a), b).length, 2)
})

test('history is newest-first and capped, oldest dropped', () => {
  let sessions: Session[] = []
  for (let i = 0; i < MAX_SESSIONS + 10; i++) {
    const at = T0 + i * 30 * MINUTE_MS
    sessions = recorded(sessions, settle(start(createTimer(), at), at + FOCUS))
  }

  assert.equal(sessions.length, MAX_SESSIONS)
  // The newest survived; the oldest were pruned.
  assert.equal(sessions[0].startedAt, T0 + (MAX_SESSIONS + 9) * 30 * MINUTE_MS)
  assert.ok(sessions[0].endedAt > sessions[sessions.length - 1].endedAt)
})

// ---------------------------------------------------------------------------
// What's on disk is input, not memory
// ---------------------------------------------------------------------------

test('a corrupt blob costs you nothing but the corrupt rows', () => {
  const good = sessionFrom(settle(start(createTimer(), T0), T0 + FOCUS).ended!)

  const parsed = parseSessions([
    good,
    null,
    'not a session',
    { startedAt: 'yesterday', endedAt: T0 },
    { startedAt: T0, endedAt: T0 - 1000, plannedMs: FOCUS, focusedMs: 5, outcome: 'completed' }, // ends before it starts
    { startedAt: T0, endedAt: T0 + 1, plannedMs: -5, focusedMs: 1, outcome: 'completed' }, // impossible plan
    { startedAt: T0, endedAt: T0 + 1, plannedMs: FOCUS, focusedMs: 1, outcome: 'vibes' }, // unknown outcome
  ])

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].id, good.id)
})

test('garbage in the slot yields an empty history, never a crash', () => {
  assert.deepEqual(deserializeSessions(null), [])
  assert.deepEqual(deserializeSessions(''), [])
  assert.deepEqual(deserializeSessions('{ not json'), [])
  assert.deepEqual(deserializeSessions('{"sessions":[]}'), []) // not an array
  assert.deepEqual(deserializeSessions('42'), [])
})

test('a hand-edited row cannot claim more focus than the block was ever going to be', () => {
  const [s] = parseSessions([
    { startedAt: T0, endedAt: T0 + FOCUS, plannedMs: FOCUS, focusedMs: 99 * 60_000, outcome: 'completed' },
  ])
  assert.equal(s.focusedMs, FOCUS)
})

test('a round trip through storage preserves history exactly', () => {
  let sessions: Session[] = []
  sessions = recorded(sessions, settle(start(createTimer(), T0), T0 + FOCUS))
  sessions = recorded(sessions, skip(start(createTimer(), T0 + 60 * MINUTE_MS), T0 + 70 * MINUTE_MS))

  assert.equal(sessions.length, 2)
  assert.deepEqual(deserializeSessions(serializeSessions(sessions)), sessions)
})

test('duplicate rows on disk collapse on read', () => {
  const s = sessionFrom(settle(start(createTimer(), T0), T0 + FOCUS).ended!)
  assert.equal(parseSessions([s, { ...s }, { ...s }]).length, 1)
})

// ---------------------------------------------------------------------------
// Reading history back
// ---------------------------------------------------------------------------

test('sessions group into local calendar days, newest first', () => {
  // 09:00 and 14:00 on one day, 09:00 the next.
  const day1 = new Date(2026, 6, 13, 9, 0).getTime()
  const day1pm = new Date(2026, 6, 13, 14, 0).getTime()
  const day2 = new Date(2026, 6, 14, 9, 0).getTime()

  let sessions: Session[] = []
  for (const at of [day1, day1pm, day2]) {
    sessions = recorded(sessions, settle(start(createTimer(), at), at + FOCUS))
  }

  const groups = groupByDay(sessions)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, dayKey(day2)) // newest day first
  assert.equal(groups[0].sessions.length, 1)
  assert.equal(groups[1].sessions.length, 2)
  assert.equal(groups[1].focusedMs, 2 * FOCUS)
  assert.equal(groups[1].completed, 2)
})

test("a late-night session belongs to the day you were sitting in, not to UTC's", () => {
  const lateLocal = new Date(2026, 6, 13, 23, 30).getTime()
  assert.equal(dayKey(lateLocal), '2026-07-13')
})

test('focus time today counts today and nothing else', () => {
  const today = new Date(2026, 6, 14, 10, 0).getTime()
  const yesterday = new Date(2026, 6, 13, 10, 0).getTime()

  let sessions: Session[] = []
  sessions = recorded(sessions, settle(start(createTimer(), yesterday), yesterday + FOCUS))
  sessions = recorded(sessions, settle(start(createTimer(), today), today + FOCUS))
  sessions = recorded(sessions, skip(start(createTimer(), today + 60 * MINUTE_MS), today + 70 * MINUTE_MS))

  // 25 completed + 10 abandoned-but-genuinely-focused = 35. Yesterday's 25 is not counted.
  assert.equal(focusedOn(sessions, today + 2 * 60 * MINUTE_MS), 35 * MINUTE_MS)
})

test('durations read as durations, not as a countdown', () => {
  assert.equal(formatFocusTime(25 * MINUTE_MS), '25m')
  assert.equal(formatFocusTime(75 * MINUTE_MS), '1h 15m')
  assert.equal(formatFocusTime(120 * MINUTE_MS), '2h')
  assert.equal(formatFocusTime(40_000), '40s')
  assert.equal(formatFocusTime(0), '0s')
})
