import { useEffect, useState } from 'react'

/**
 * Remaining time is always derived from a wall-clock target, never accumulated
 * from ticks. The interval only decides *when we re-render*; if the browser
 * throttles it in a background tab, or the machine sleeps, the next tick still
 * reads the correct remaining time from Date.now().
 *
 * Skeleton engine for TES-2 — pause/resume/skip and persistence land with the
 * real engine.
 */
export function useCountdown(targetAt: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    targetAt === null ? 0 : Math.max(0, targetAt - Date.now()),
  )

  useEffect(() => {
    if (targetAt === null) {
      setRemaining(0)
      return
    }

    const read = () => setRemaining(Math.max(0, targetAt - Date.now()))
    read()

    const id = setInterval(read, 250)
    // A throttled background tab may not have ticked for minutes; resync the
    // instant the tab is visible again rather than waiting for the next tick.
    document.addEventListener('visibilitychange', read)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', read)
    }
  }, [targetAt])

  return remaining
}
