/**
 * localStorage wrapper. All the thinking lives in persist.ts; this is just the
 * part that touches the browser.
 *
 * Reload is not a special case for us: `targetAt` is an absolute instant, so a
 * timer started at 10:00 and reloaded at 10:07 has 18 minutes left because the
 * deadline says so. Read it back, settle() it against the clock, carry on.
 *
 * Every access is wrapped: Safari in private mode *throws* on localStorage
 * rather than returning null, and a timer that cannot persist is still a
 * perfectly good timer for the next 25 minutes.
 */
import { createTimer, type TimerState } from './timer.ts'
import { deserializeTimer, serializeTimer, STORAGE_KEY } from './persist.ts'
import { deserializeSessions, serializeSessions, type Session } from './sessions.ts'

/**
 * History lives under its own key, not inside the timer blob.
 *
 * The timer is a small, hot, overwritten-every-transition scratchpad; history is
 * an append-only record of work you actually did. Keeping them separate means a
 * malformed timer blob costs you a countdown you can restart in one click, and
 * not three weeks of sessions — which is the one thing here that is genuinely
 * unrecoverable.
 */
export const SESSIONS_KEY = 'clock.sessions.v1'

export function loadTimer(): TimerState {
  try {
    return deserializeTimer(localStorage.getItem(STORAGE_KEY))
  } catch {
    return createTimer()
  }
}

export function saveTimer(state: TimerState): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeTimer(state))
  } catch {
    // Storage full, blocked, or unavailable. Nothing to do but keep running.
  }
}

export function loadSessions(): Session[] {
  try {
    return deserializeSessions(localStorage.getItem(SESSIONS_KEY))
  } catch {
    return []
  }
}

export function saveSessions(sessions: Session[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, serializeSessions(sessions))
  } catch {
    // Quota, private mode, or storage disabled. The in-memory history is still
    // good for this run; we just cannot promise it will be here tomorrow.
  }
}
