export const MINUTE_MS = 60_000

/** Clamped so a countdown never renders a negative value after overshooting its target. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function progress(remainingMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0
  const elapsed = totalMs - remainingMs
  return Math.min(1, Math.max(0, elapsed / totalMs))
}
