/**
 * Turning an untrusted blob back into a TimerState.
 *
 * Pure on purpose — no localStorage, no DOM (see storage.ts for that). What's
 * on disk survives across deploys and can be hand-edited, so it is input, not
 * memory: a malformed blob must degrade to a fresh timer, never to a timer
 * rendering NaN or counting down to a deadline in 1970.
 */
import {
  createTimer,
  DEFAULT_CONFIG,
  durationFor,
  type Phase,
  type TimerConfig,
  type TimerState,
  type TimerStatus,
} from './timer.ts'

export const STORAGE_KEY = 'clock.timer.v1'

/** Guard rails on hand-editable durations: 1 minute … 8 hours. */
export const MIN_PHASE_MS = 60_000
export const MAX_PHASE_MS = 8 * 60 * 60_000

const PHASES: Phase[] = ['focus', 'shortBreak', 'longBreak']
const STATUSES: TimerStatus[] = ['idle', 'running', 'paused']

const isPositive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0

const isFinite_ = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function clampPhaseMs(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_PHASE_MS
  return Math.min(MAX_PHASE_MS, Math.max(MIN_PHASE_MS, Math.round(ms)))
}

export function parseConfig(raw: unknown): TimerConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG
  const c = raw as Partial<Record<keyof TimerConfig, unknown>>

  return {
    focusMs: isPositive(c.focusMs) ? clampPhaseMs(c.focusMs) : DEFAULT_CONFIG.focusMs,
    shortBreakMs: isPositive(c.shortBreakMs)
      ? clampPhaseMs(c.shortBreakMs)
      : DEFAULT_CONFIG.shortBreakMs,
    longBreakMs: isPositive(c.longBreakMs)
      ? clampPhaseMs(c.longBreakMs)
      : DEFAULT_CONFIG.longBreakMs,
    longBreakEvery: isPositive(c.longBreakEvery)
      ? Math.min(12, Math.round(c.longBreakEvery))
      : DEFAULT_CONFIG.longBreakEvery,
  }
}

/** Rebuild a TimerState, or null for "unusable — start fresh". */
export function parseTimerState(raw: unknown): TimerState | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>

  const status = s.status as TimerStatus
  const phase = s.phase as Phase
  if (!STATUSES.includes(status) || !PHASES.includes(phase)) return null

  const config = parseConfig(s.config)

  // A running timer without a deadline is not a running timer — there is no
  // safe way to guess how much time it had left, so throw it away.
  const targetAt = isFinite_(s.targetAt) ? s.targetAt : null
  if (status === 'running' && targetAt === null) return null

  // Likewise, a phase that is running or paused *has run*, so it must know when
  // it began. Without that we could not honestly date the session it will end
  // up writing to history, and a session with an invented start time is worse
  // than no session. Reject rather than guess.
  const startedAt = isFinite_(s.startedAt) ? s.startedAt : null
  if (status !== 'idle' && startedAt === null) return null

  const phaseTotalMs = isPositive(s.phaseTotalMs) ? s.phaseTotalMs : durationFor(phase, config)
  const remainingMs =
    isFinite_(s.remainingMs) && s.remainingMs >= 0
      ? Math.min(s.remainingMs, phaseTotalMs)
      : phaseTotalMs

  return {
    status,
    phase,
    phaseTotalMs,
    targetAt,
    remainingMs,
    startedAt,
    focusCount: isFinite_(s.focusCount) && s.focusCount >= 0 ? Math.floor(s.focusCount) : 0,
    config,
  }
}

/** Parse a raw JSON string from storage; anything unusable becomes a fresh timer. */
export function deserializeTimer(json: string | null): TimerState {
  if (!json) return createTimer()
  try {
    return parseTimerState(JSON.parse(json)) ?? createTimer()
  } catch {
    return createTimer()
  }
}

export function serializeTimer(state: TimerState): string {
  return JSON.stringify(state)
}
