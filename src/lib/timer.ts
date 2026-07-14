/**
 * The timer engine.
 *
 * Two rules hold this file together, and everything else follows from them:
 *
 * 1. TIME IS AN ARGUMENT, NEVER A READING. No function here calls Date.now().
 *    The caller passes `now`. That makes every transition — including "the
 *    laptop was asleep for three hours" — an ordinary, testable function call.
 *
 * 2. A RUNNING PHASE IS A DEADLINE, NOT A COUNTER. While running we store
 *    `targetAt`, an absolute wall-clock instant. Remaining time is *derived*
 *    (`targetAt - now`), never accumulated from ticks. Background-tab
 *    throttling, sleep/wake, and reload all reduce to the same thing: we
 *    look at the clock again and recompute. There is nothing to lose.
 *
 * The subtle one is `settle()`. See the comment there.
 */

export type Phase = 'focus' | 'shortBreak' | 'longBreak'
export type TimerStatus = 'idle' | 'running' | 'paused'

export type TimerConfig = {
  focusMs: number
  shortBreakMs: number
  longBreakMs: number
  /** Long break after every Nth completed focus block. */
  longBreakEvery: number
}

export type TimerState = {
  status: TimerStatus
  phase: Phase
  /**
   * Length of the phase as it was when the phase began. Snapshotted rather
   * than read from config so that editing durations mid-phase cannot warp a
   * phase already in flight (or make the progress ring jump).
   */
  phaseTotalMs: number
  /** Absolute wall-clock instant the phase ends. Only meaningful while running. */
  targetAt: number | null
  /** Authoritative remaining time while idle or paused. Ignored while running. */
  remainingMs: number
  /** When the current phase first started running. Null until it does. */
  startedAt: number | null
  /** Completed focus blocks. Drives the long-break cadence. */
  focusCount: number
  config: TimerConfig
}

/** A focus block either runs to zero, or you walk away from it. Nothing else. */
export type Outcome = 'completed' | 'abandoned'

/**
 * A phase that ended, and the whole truth about it. This is the engine's only
 * output to history — sessions are built from these and nothing else.
 *
 * `startedAt` is non-null by construction: a phase that never ran cannot end,
 * so hitting Reset on an untouched clock emits nothing at all.
 */
export type PhaseEnd = {
  phase: Phase
  outcome: Outcome
  /** The phase length it set out to do. */
  plannedMs: number
  /**
   * Time the clock was actually *running*. Excludes time spent paused, so a
   * 25-minute block you paused for an hour in the middle of is 25 minutes of
   * focus, not 85. For a completed phase this is exactly `plannedMs`.
   */
  elapsedMs: number
  startedAt: number
  /** The instant the phase *actually* ended — not the instant we noticed. */
  endedAt: number
}

export const MINUTE_MS = 60_000

export const DEFAULT_CONFIG: TimerConfig = {
  focusMs: 25 * MINUTE_MS,
  shortBreakMs: 5 * MINUTE_MS,
  longBreakMs: 15 * MINUTE_MS,
  longBreakEvery: 4,
}

export const PHASE_LABELS: Record<Phase, string> = {
  focus: 'focus',
  shortBreak: 'short break',
  longBreak: 'long break',
}

export function durationFor(phase: Phase, config: TimerConfig): number {
  if (phase === 'focus') return config.focusMs
  if (phase === 'shortBreak') return config.shortBreakMs
  return config.longBreakMs
}

/**
 * `focusCount` is the count *after* the block being completed, so a cadence of
 * 4 puts the long break after the 4th, 8th, ... focus block.
 */
function breakAfter(focusCount: number, config: TimerConfig): Phase {
  const every = config.longBreakEvery
  if (every > 0 && focusCount % every === 0) return 'longBreak'
  return 'shortBreak'
}

export function createTimer(config: TimerConfig = DEFAULT_CONFIG): TimerState {
  return {
    status: 'idle',
    phase: 'focus',
    phaseTotalMs: config.focusMs,
    targetAt: null,
    remainingMs: config.focusMs,
    startedAt: null,
    focusCount: 0,
    config,
  }
}

/** Enter `phase` fresh and idle, ready to be started. */
function enterPhase(state: TimerState, phase: Phase): TimerState {
  const total = durationFor(phase, state.config)
  return {
    ...state,
    status: 'idle',
    phase,
    phaseTotalMs: total,
    targetAt: null,
    remainingMs: total,
    startedAt: null,
  }
}

/**
 * Remaining time on the clock at instant `now`.
 *
 * Clamped to [0, phaseTotalMs]. The upper clamp matters: if the system clock
 * jumps *backwards* (NTP correction, user changing the date), `targetAt - now`
 * can exceed the phase length, and we'd render a countdown reading longer than
 * the phase itself. Clamping keeps the display sane; the deadline still governs.
 */
export function remainingAt(state: TimerState, now: number): number {
  const raw =
    state.status === 'running' && state.targetAt !== null
      ? state.targetAt - now
      : state.remainingMs
  return Math.min(state.phaseTotalMs, Math.max(0, raw))
}

export function isExpired(state: TimerState, now: number): boolean {
  return state.status === 'running' && state.targetAt !== null && now >= state.targetAt
}

export function start(state: TimerState, now: number): TimerState {
  if (state.status === 'running') return state
  const remaining = remainingAt(state, now)
  if (remaining <= 0) return state
  return {
    ...state,
    status: 'running',
    targetAt: now + remaining,
    startedAt: state.startedAt ?? now,
  }
}

export function pause(state: TimerState, now: number): TimerState {
  if (state.status !== 'running') return state
  return {
    ...state,
    status: 'paused',
    // Freeze the derived value; the deadline is meaningless once time stops.
    remainingMs: remainingAt(state, now),
    targetAt: null,
  }
}

/**
 * Describe the phase that is ending. Null when there is nothing to describe:
 * `startedAt` is only set once a phase has actually run, so an untouched clock
 * that gets Reset or Skipped ends nothing and writes nothing to history.
 *
 * Time already spent is `phaseTotalMs - remaining`, which is exactly the right
 * number in every case: pauses never moved the deadline, so they never inflate
 * it, and a completed phase has zero remaining and therefore banked its full
 * length.
 */
function endOf(state: TimerState, endedAt: number, outcome: Outcome): PhaseEnd | null {
  if (state.startedAt === null) return null
  return {
    phase: state.phase,
    outcome,
    plannedMs: state.phaseTotalMs,
    elapsedMs: state.phaseTotalMs - remainingAt(state, endedAt),
    startedAt: state.startedAt,
    endedAt,
  }
}

/** A transition that can end the current phase, and the end it produced (if any). */
export type Transition = { state: TimerState; ended: PhaseEnd | null }

/**
 * Restart the current phase from full, without touching the cycle count.
 *
 * Time already served is abandoned, not erased: ten minutes into a pomodoro,
 * Reset means you gave up on that block, and history should say so.
 */
export function reset(state: TimerState, now: number): Transition {
  return { state: enterPhase(state, state.phase), ended: endOf(state, now, 'abandoned') }
}

/**
 * Abandon the current phase and move to the next one.
 *
 * A skipped focus block is deliberately NOT counted as completed — you didn't
 * do the work, so it must not advance the long-break cadence, and it lands in
 * history as `abandoned`.
 */
export function skip(state: TimerState, now: number): Transition {
  const next: Phase =
    state.phase === 'focus' ? breakAfter(state.focusCount + 1, state.config) : 'focus'
  return { state: enterPhase(state, next), ended: endOf(state, now, 'abandoned') }
}

/**
 * The current phase reached zero at instant `endedAt`, and we advance to the
 * next one. Split out from settle() so the "what comes next" rule lives in
 * exactly one place.
 */
function complete(state: TimerState, endedAt: number): Transition {
  const ended = endOf(state, endedAt, 'completed')

  const focusCount = state.phase === 'focus' ? state.focusCount + 1 : state.focusCount
  const next: Phase = state.phase === 'focus' ? breakAfter(focusCount, state.config) : 'focus'

  return { state: enterPhase({ ...state, focusCount }, next), ended }
}

/**
 * Bring the state up to date with the wall clock. Call it on every tick, on
 * visibilitychange, and on load.
 *
 * THE IMPORTANT DECISION LIVES HERE. If a phase's deadline passed while we
 * weren't looking (tab hidden, laptop asleep, page closed for two hours), we
 * complete exactly ONE phase — the one that was running — and land on the next
 * phase *idle*, waiting for a human. We do not auto-start it, and we therefore
 * never chain: sleeping through lunch cannot silently "complete" six pomodoros
 * and four breaks you did not take.
 *
 * That gives the engine a property worth stating plainly: the outcome does not
 * depend on whether anyone was watching. A 25-minute focus block that ends at
 * 10:25 completes at 10:25, with `endedAt` 10:25 — whether you were staring at
 * the tab, or the lid was shut and you opened it at 13:00. The session written
 * to history says 10:00–10:25 either way.
 */
export function settle(state: TimerState, now: number): Transition {
  if (!isExpired(state, now)) return { state, ended: null }
  // targetAt is non-null whenever isExpired() is true.
  return complete(state, state.targetAt as number)
}

/**
 * Apply a config change. Durations of a phase already in flight are left alone
 * (see `phaseTotalMs`), but an idle phase re-derives immediately so that
 * dialing focus up to 50 minutes shows 50:00 on the clock right away.
 */
export function applyConfig(state: TimerState, config: TimerConfig): TimerState {
  const next = { ...state, config }
  if (state.status !== 'idle') return next

  const total = durationFor(state.phase, config)
  return { ...next, phaseTotalMs: total, remainingMs: total }
}

/** Fraction of the current phase already elapsed, in [0, 1]. */
export function progress(remainingMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0
  return Math.min(1, Math.max(0, (totalMs - remainingMs) / totalMs))
}

/** mm:ss, rounding up so a fresh 25-minute phase reads 25:00 and not 24:59. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
