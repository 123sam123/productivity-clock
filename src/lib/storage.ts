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
