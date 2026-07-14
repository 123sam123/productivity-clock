/**
 * Engine tests. Run with `npm test` (node --test, native type stripping).
 *
 * The engine never reads the clock — `now` is always an argument — so the
 * scenarios that are slow or impossible to stage in a browser (a three-hour
 * laptop sleep, an NTP correction dragging the clock backwards, a corrupt
 * localStorage blob) are just function calls here. The browser run in
 * scripts/verify-timer.mjs proves the same properties hold for real.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CONFIG,
  MINUTE_MS,
  createTimer,
  formatDuration,
  pause,
  remainingAt,
  reset,
  settle,
  skip,
  start,
  applyConfig,
  type TimerState,
} from './timer.ts'
import { deserializeTimer, parseTimerState, serializeTimer } from './persist.ts'

const T0 = 1_700_000_000_000 // fixed epoch; nothing here depends on the real clock
const FOCUS = 25 * MINUTE_MS

/** Run the timer to the end of its current phase and settle, as the UI would. */
const runToEnd = (state: TimerState, at: number) => settle(state, at)

test('a fresh timer sits idle at a full focus phase', () => {
  const t = createTimer()
  assert.equal(t.status, 'idle')
  assert.equal(t.phase, 'focus')
  assert.equal(remainingAt(t, T0), FOCUS)
  assert.equal(formatDuration(remainingAt(t, T0)), '25:00')
})

test('remaining time is derived from the deadline, not from elapsed ticks', () => {
  const t = start(createTimer(), T0)
  // No ticks happened at all. The clock simply moved.
  assert.equal(remainingAt(t, T0 + 60_000), FOCUS - 60_000)
  assert.equal(remainingAt(t, T0 + 10 * MINUTE_MS), 15 * MINUTE_MS)
  assert.equal(formatDuration(remainingAt(t, T0 + 10 * MINUTE_MS)), '15:00')
})

test('pause freezes the clock and resume does not lose the paused time', () => {
  const started = start(createTimer(), T0)
  const paused = pause(started, T0 + 5 * MINUTE_MS)

  assert.equal(paused.status, 'paused')
  assert.equal(paused.targetAt, null)
  assert.equal(remainingAt(paused, T0 + 5 * MINUTE_MS), 20 * MINUTE_MS)

  // An hour goes by while paused. A paused timer owes nothing to the wall clock.
  assert.equal(remainingAt(paused, T0 + 65 * MINUTE_MS), 20 * MINUTE_MS)

  const resumed = start(paused, T0 + 65 * MINUTE_MS)
  assert.equal(resumed.status, 'running')
  assert.equal(remainingAt(resumed, T0 + 65 * MINUTE_MS), 20 * MINUTE_MS)
  // ...and it now ends 20 minutes after the resume, not 20 after the pause.
  assert.equal(resumed.targetAt, T0 + 85 * MINUTE_MS)
})

test('a phase that ended while we were away completes at its deadline, not on our return', () => {
  const running = start(createTimer(), T0)

  // Lid shut at minute 2, reopened three hours later.
  const { state, ended: completion } = runToEnd(running, T0 + 3 * 60 * MINUTE_MS)

  assert.ok(completion, 'the focus block should have completed')
  assert.equal(completion.phase, 'focus')
  // The honest timestamp: it ended when it ended, not when we noticed.
  assert.equal(completion.endedAt, T0 + FOCUS)
  assert.equal(completion.startedAt, T0)
  assert.equal(completion.plannedMs, FOCUS)

  // And we land on the break, idle, waiting for a human.
  assert.equal(state.phase, 'shortBreak')
  assert.equal(state.status, 'idle')
  assert.equal(state.focusCount, 1)
  assert.equal(remainingAt(state, T0 + 3 * 60 * MINUTE_MS), 5 * MINUTE_MS)
})

test('sleeping through the afternoon does not chain-complete phases you never did', () => {
  // Eight hours would be ~16 pomodoros if we auto-advanced through absence.
  let state = start(createTimer(), T0)
  const wake = T0 + 8 * 60 * MINUTE_MS

  const first = settle(state, wake)
  state = first.state
  assert.equal(first.ended?.phase, 'focus')
  assert.equal(state.focusCount, 1, 'exactly one focus block was actually worked')

  // Settling again changes nothing: the next phase is idle, so there is no
  // second deadline in the past to trip over.
  const second = settle(state, wake)
  assert.equal(second.ended, null)
  assert.equal(second.state, state)
  assert.equal(second.state.focusCount, 1)
})

test('settling repeatedly mid-phase is a no-op', () => {
  const running = start(createTimer(), T0)
  const { state, ended: completion } = settle(running, T0 + MINUTE_MS)
  assert.equal(completion, null)
  assert.equal(state, running, 'identity preserved, so React does not re-render')
})

test('the long break lands on every 4th completed focus block', () => {
  let state = createTimer()
  const phases: string[] = []
  let at = T0

  // Work twelve phases: focus, break, focus, break, ...
  for (let i = 0; i < 12; i++) {
    state = start(state, at)
    at += state.phaseTotalMs
    const settled = settle(state, at)
    state = settled.state
    phases.push(state.phase)
  }

  // After each focus completes we enter a break; after the 4th, a long one.
  assert.deepEqual(phases, [
    'shortBreak', 'focus',
    'shortBreak', 'focus',
    'shortBreak', 'focus',
    'longBreak', 'focus',   // 4th focus → long break
    'shortBreak', 'focus',
    'shortBreak', 'focus',
  ])
  assert.equal(state.focusCount, 6)
})

test('skipping a focus block does not count it as work', () => {
  const running = start(createTimer(), T0)
  const skipped = skip(running, T0 + 10 * MINUTE_MS).state

  assert.equal(skipped.phase, 'shortBreak')
  assert.equal(skipped.status, 'idle')
  assert.equal(skipped.focusCount, 0, 'you did not do the work, so it must not count')
  assert.equal(skipped.startedAt, null)

  // Which means a skipped block cannot drag the long break forward either.
  assert.equal(skip(skipped, T0).state.phase, 'focus')
})

test('reset restarts the phase without discarding completed cycles', () => {
  let state = start(createTimer(), T0)
  state = settle(state, T0 + FOCUS).state // one focus done
  state = start(state, T0 + FOCUS) // start the break
  state = reset(state, T0 + FOCUS).state

  assert.equal(state.status, 'idle')
  assert.equal(state.phase, 'shortBreak')
  assert.equal(remainingAt(state, T0), 5 * MINUTE_MS)
  assert.equal(state.focusCount, 1, 'the focus block you already did still happened')
})

test('a backwards clock jump cannot inflate the countdown past the phase length', () => {
  const running = start(createTimer(), T0)
  // NTP drags the clock back ten minutes, so targetAt - now > phaseTotalMs.
  const remaining = remainingAt(running, T0 - 10 * MINUTE_MS)
  assert.equal(remaining, FOCUS, 'clamped to the phase length, never longer')
  assert.ok(remaining <= running.phaseTotalMs)
})

test('custom intervals: a config change resizes an idle phase but never one in flight', () => {
  const custom = { ...DEFAULT_CONFIG, focusMs: 50 * MINUTE_MS, shortBreakMs: 10 * MINUTE_MS }

  // Idle: the clock face should immediately read the new duration.
  const idle = applyConfig(createTimer(), custom)
  assert.equal(remainingAt(idle, T0), 50 * MINUTE_MS)
  assert.equal(formatDuration(remainingAt(idle, T0)), '50:00')

  // Running: retuning mid-phase must not warp the phase you're inside of.
  const running = start(createTimer(), T0) // still a 25m phase
  const retuned = applyConfig(running, custom)
  assert.equal(retuned.phaseTotalMs, FOCUS)
  assert.equal(retuned.targetAt, T0 + FOCUS, 'the deadline you started against still holds')

  // The new duration takes effect on the next phase.
  const next = settle(retuned, T0 + FOCUS).state
  assert.equal(next.phase, 'shortBreak')
  assert.equal(remainingAt(next, T0 + FOCUS), 10 * MINUTE_MS)
})

test('a running timer survives a serialize/deserialize round trip', () => {
  const running = start(createTimer(), T0)
  const restored = deserializeTimer(serializeTimer(running))

  assert.deepEqual(restored, running)
  // Reloaded seven minutes in: the deadline, not the reload, decides.
  assert.equal(remainingAt(restored, T0 + 7 * MINUTE_MS), 18 * MINUTE_MS)
})

test('a phase that ended while the page was closed settles on load', () => {
  const running = start(createTimer(), T0)
  const restored = deserializeTimer(serializeTimer(running))
  const { state, ended: completion } = settle(restored, T0 + 40 * MINUTE_MS)

  assert.equal(completion?.endedAt, T0 + FOCUS)
  assert.equal(state.phase, 'shortBreak')
  assert.equal(state.focusCount, 1)
})

test('corrupt or hostile storage degrades to a fresh timer, never to NaN', () => {
  const fresh = createTimer()

  assert.deepEqual(deserializeTimer(null), fresh)
  assert.deepEqual(deserializeTimer('not json at all'), fresh)
  assert.deepEqual(deserializeTimer('"a string"'), fresh)
  assert.deepEqual(deserializeTimer('{}'), fresh, 'no status/phase → unusable')

  // Running with no deadline: unusable, because we cannot invent the remainder.
  assert.equal(parseTimerState({ status: 'running', phase: 'focus', targetAt: null }), null)
  assert.equal(parseTimerState({ status: 'nonsense', phase: 'focus' }), null)

  // A phase that is running or paused HAS run, so it must know when it began —
  // otherwise the session it eventually writes to history would carry an
  // invented start time, and a lie in the record is worse than a missing row.
  assert.equal(
    parseTimerState({ status: 'running', phase: 'focus', targetAt: T0 + FOCUS, startedAt: null }),
    null,
  )
  assert.equal(parseTimerState({ status: 'paused', phase: 'focus', remainingMs: 1000 }), null)

  // NaN/Infinity anywhere must not reach the render path.
  const poisoned = parseTimerState({
    status: 'paused',
    phase: 'focus',
    startedAt: T0,
    remainingMs: Number.NaN,
    phaseTotalMs: Number.POSITIVE_INFINITY,
    focusCount: -5,
    config: { focusMs: Number.NaN, shortBreakMs: -1, longBreakMs: 0, longBreakEvery: Number.NaN },
  })
  assert.ok(poisoned)
  assert.ok(Number.isFinite(poisoned.remainingMs))
  assert.ok(Number.isFinite(poisoned.phaseTotalMs))
  assert.equal(poisoned.focusCount, 0)
  assert.deepEqual(poisoned.config, DEFAULT_CONFIG)
  assert.equal(formatDuration(remainingAt(poisoned, T0)), '25:00')
})

test('absurd hand-edited durations are clamped, not obeyed', () => {
  const parsed = parseTimerState({
    status: 'idle',
    phase: 'focus',
    config: { focusMs: 999 * 60 * MINUTE_MS, shortBreakMs: 1, longBreakMs: 5 * MINUTE_MS, longBreakEvery: 4 },
  })
  assert.ok(parsed)
  assert.equal(parsed.config.focusMs, 8 * 60 * MINUTE_MS, 'capped at 8 hours')
  assert.equal(parsed.config.shortBreakMs, MINUTE_MS, 'floored at 1 minute')
})

test('formatDuration rounds up, so a fresh phase reads 25:00 rather than 24:59', () => {
  assert.equal(formatDuration(FOCUS), '25:00')
  assert.equal(formatDuration(FOCUS - 1), '25:00')
  assert.equal(formatDuration(59_400), '01:00')
  assert.equal(formatDuration(1), '00:01')
  assert.equal(formatDuration(0), '00:00')
  assert.equal(formatDuration(-5_000), '00:00', 'an overshot deadline never renders negative')
})
