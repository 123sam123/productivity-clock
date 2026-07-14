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
 *
 * ---------------------------------------------------------------------------
 * WHY SESSIONS ARE RECORDED INSIDE THE STATE UPDATER
 *
 * Writing history looks like a side effect, and the reflex is to reach for an
 * effect. Resist it: an effect watching for "a phase ended" has to remember
 * which ends it already wrote, and that bookkeeping is exactly where
 * double-recording bugs live. React double-invokes updaters in StrictMode, and
 * settle() can race itself on wake — interval, visibilitychange and focus can
 * all fire in the same breath.
 *
 * So we make recording PURE instead. A session's id is derived from its own
 * timestamps, so `record()` is idempotent: replaying the same PhaseEnd lands on
 * the same row. Nothing to deduplicate, nothing to remember — and timer state
 * and history move in one atomic update, so they can never disagree about
 * whether a block finished.
 */
import { useCallback, useEffect, useState } from 'react'
import { loadSessions, loadTimer, saveSessions, saveTimer } from '../lib/storage.ts'
import { focusedOn, record, type Session } from '../lib/sessions.ts'
import {
  applyConfig,
  pause as pauseTimer,
  remainingAt,
  reset as resetTimer,
  settle,
  skip as skipTimer,
  start as startTimer,
  type PhaseEnd,
  type TimerConfig,
  type TimerState,
  type Transition,
} from '../lib/timer.ts'

/** 200ms keeps the seconds digit honest without burning a frame budget. */
const TICK_MS = 200

type Snapshot = {
  state: TimerState
  sessions: Session[]
  /** The phase that most recently ran to zero, for the "phase complete" banner. */
  lastCompleted: PhaseEnd | null
}

/**
 * Fold a phase-end into the snapshot: history gains a row (if it earned one),
 * and a *completed* phase raises the banner. An abandoned one does not — you
 * skipped it, you don't need to be congratulated for it.
 */
function commit(snap: Snapshot, state: TimerState, ended: PhaseEnd | null): Snapshot {
  return {
    state,
    sessions: record(snap.sessions, ended),
    lastCompleted: ended?.outcome === 'completed' ? ended : snap.lastCompleted,
  }
}

/** Lift a transition that cannot end a phase into the common shape. */
const plain =
  (fn: (s: TimerState, at: number) => TimerState) =>
  (s: TimerState, at: number): Transition => ({ state: fn(s, at), ended: null })

export function useTimer() {
  const [snap, setSnap] = useState<Snapshot>(() => {
    // The page may have been closed across a deadline. Settle before first paint
    // so we never flash a stale or negative countdown — and so a block that ran
    // to zero while the tab was shut is already in history by the time anyone
    // looks at it.
    const { state, ended } = settle(loadTimer(), Date.now())
    return commit({ state, sessions: loadSessions(), lastCompleted: null }, state, ended)
  })
  const [now, setNow] = useState(() => Date.now())

  const { state, sessions } = snap
  const running = state.status === 'running'

  useEffect(() => {
    saveTimer(state)
  }, [state])

  // `sessions` is identity-stable unless a row was actually added, so this does
  // not re-serialize the whole history on every tick of the clock.
  useEffect(() => {
    saveSessions(sessions)
  }, [sessions])

  useEffect(() => {
    // Idle and paused states are frozen — no deadline to race, nothing to
    // repaint. Only a running timer needs a heartbeat.
    if (!running) return

    const sync = () => {
      const at = Date.now()
      setNow(at)
      setSnap((prev) => {
        const { state: next, ended } = settle(prev.state, at)
        // Identity-stable when nothing ended, so this doesn't re-render on every
        // tick just to hand back an equal object.
        if (!ended) return prev
        return commit(prev, next, ended)
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

  // An IDLE clock still needs to know what day it is. Left open overnight, the
  // history headings ("Today") and today's focus total would otherwise still be
  // describing yesterday. No interval for this — just look at the clock again
  // whenever someone looks at the tab.
  useEffect(() => {
    const resync = () => setNow(Date.now())
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('focus', resync)
    return () => {
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('focus', resync)
    }
  }, [])

  const act = useCallback((fn: (s: TimerState, at: number) => Transition) => {
    // Read the clock once, outside the updater: state updaters must stay pure
    // (React may run them twice), and every transition in a single user action
    // must agree on what "now" was.
    const at = Date.now()
    setNow(at)
    setSnap((prev) => {
      const { state: next, ended } = fn(prev.state, at)
      // Any deliberate action dismisses the banner; commit() raises it again if
      // this very action completed a phase.
      return commit({ ...prev, lastCompleted: null }, next, ended)
    })
  }, [])

  const start = useCallback(() => act(plain(startTimer)), [act])
  const pause = useCallback(() => act(plain(pauseTimer)), [act])
  const reset = useCallback(() => act(resetTimer), [act])
  const skip = useCallback(() => act(skipTimer), [act])
  const setConfig = useCallback(
    (config: TimerConfig) => act(plain((s) => applyConfig(s, config))),
    [act],
  )
  const dismissCompletion = useCallback(
    () => setSnap((prev) => (prev.lastCompleted ? { ...prev, lastCompleted: null } : prev)),
    [],
  )

  return {
    state,
    sessions,
    now,
    remainingMs: remainingAt(state, now),
    focusedToday: focusedOn(sessions, now),
    lastCompleted: snap.lastCompleted,
    start,
    pause,
    reset,
    skip,
    setConfig,
    dismissCompletion,
  }
}
