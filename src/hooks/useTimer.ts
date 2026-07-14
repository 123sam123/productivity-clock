/**
 * React binding for the timer engine.
 *
 * The interval in here does exactly one job: schedule re-renders. It does NOT
 * advance the clock — no counter, nothing accumulated per tick. Every render
 * re-derives remaining time from the stored deadline via `remainingAt()`. If
 * the browser throttles this interval to once a minute (which it does, in
 * hidden tabs), the only consequence is that we repaint less often; the number
 * we paint is still correct to the millisecond.
 *
 * That is the entire trick, and it's why we also resync on visibilitychange —
 * not to fix the time, but to repaint the already-correct time immediately
 * instead of up to a minute late.
 */
import { useCallback, useEffect, useState } from 'react'
import { loadTimer, saveTimer } from '../lib/storage.ts'
import {
  applyConfig,
  pause as pauseTimer,
  remainingAt,
  reset as resetTimer,
  settle,
  skip as skipTimer,
  start as startTimer,
  type Completion,
  type TimerConfig,
  type TimerState,
} from '../lib/timer.ts'

/** 200ms keeps the seconds digit honest without burning a frame budget. */
const TICK_MS = 200

type Snapshot = {
  state: TimerState
  /** The phase that most recently ran to zero, for the "phase complete" banner. */
  lastCompleted: Completion | null
}

export function useTimer() {
  const [snap, setSnap] = useState<Snapshot>(() => {
    // The page may have been closed across a deadline. Settle before first paint
    // so we never flash a stale or negative countdown.
    const { state, completion } = settle(loadTimer(), Date.now())
    return { state, lastCompleted: completion }
  })
  const [now, setNow] = useState(() => Date.now())

  const { state } = snap
  const running = state.status === 'running'

  useEffect(() => {
    saveTimer(state)
  }, [state])

  useEffect(() => {
    // Idle and paused states are frozen — no deadline to race, nothing to
    // repaint. Only a running timer needs a heartbeat.
    if (!running) return

    const sync = () => {
      const at = Date.now()
      setNow(at)
      setSnap((prev) => {
        const next = settle(prev.state, at)
        // Identity-stable when nothing completed, so this doesn't re-render on
        // every tick just to hand back an equal object.
        if (!next.completion) return prev
        return { state: next.state, lastCompleted: next.completion }
      })
    }

    sync()
    const id = setInterval(sync, TICK_MS)

    // A hidden tab's interval may not have fired for a minute; a slept machine's
    // may not have fired for hours. Repaint the instant we're looked at again.
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('focus', sync)
    // Restored from the back/forward cache: no reload, no fresh mount, so this
    // is the only signal we get.
    window.addEventListener('pageshow', sync)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('focus', sync)
      window.removeEventListener('pageshow', sync)
    }
  }, [running])

  const act = useCallback((fn: (s: TimerState, at: number) => TimerState) => {
    // Read the clock once, outside the updater: state updaters must stay pure
    // (React may run them twice), and every transition in a single user action
    // must agree on what "now" was.
    const at = Date.now()
    setNow(at)
    setSnap((prev) => ({ state: fn(prev.state, at), lastCompleted: null }))
  }, [])

  const start = useCallback(() => act(startTimer), [act])
  const pause = useCallback(() => act(pauseTimer), [act])
  const reset = useCallback(() => act((s) => resetTimer(s)), [act])
  const skip = useCallback(() => act((s) => skipTimer(s)), [act])
  const setConfig = useCallback(
    (config: TimerConfig) => act((s) => applyConfig(s, config)),
    [act],
  )
  const dismissCompletion = useCallback(
    () => setSnap((prev) => (prev.lastCompleted ? { ...prev, lastCompleted: null } : prev)),
    [],
  )

  return {
    state,
    remainingMs: remainingAt(state, now),
    lastCompleted: snap.lastCompleted,
    start,
    pause,
    reset,
    skip,
    setConfig,
    dismissCompletion,
  }
}
