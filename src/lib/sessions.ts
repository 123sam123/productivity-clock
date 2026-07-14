/**
 * Sessions: what the timer leaves behind.
 *
 * The engine (timer.ts) knows about time and nothing else. This module turns
 * the `PhaseEnd`s it emits into durable history. Pure — no storage, no DOM, no
 * clock (see storage.ts for the part that touches the browser).
 *
 * ---------------------------------------------------------------------------
 * WHY localStorage AND NOT IndexedDB
 *
 * A session is ~120 bytes of JSON. Someone doing a genuinely punishing sixteen
 * pomodoros a day writes under 3 KB a week — call it 150 KB a year, against a
 * ~5 MB budget. We are not close to the ceiling, and `MAX_SESSIONS` keeps it
 * that way by construction.
 *
 * IndexedDB would buy us async writes, a bigger quota, and indexed range
 * queries. We need none of the three: we read the whole history once at load
 * and hold it in memory, and every query stats will ever ask ("focus time this
 * week", "what's my streak") is a scan over an array that fits in L2 cache.
 *
 * What localStorage buys us is the thing that actually matters here: it is
 * SYNCHRONOUS. History is on screen in the first paint, with no loading state
 * and no flash of an empty list — on a clock you leave open all day and reload
 * without thinking, that is the whole user-visible difference. IndexedDB would
 * cost us a spinner to buy headroom we will not use.
 *
 * If that ever stops being true, it stops being true behind this module and
 * storage.ts, which is the point of them being separate.
 * ---------------------------------------------------------------------------
 */
import type { PhaseEnd, Outcome } from './timer.ts'

export type SessionOutcome = Outcome

export type Session = {
  /**
   * Derived, not random: an instant can only start one focus block, so
   * `${startedAt}-${endedAt}` is already unique. Deriving it makes recording
   * IDEMPOTENT — replaying the same PhaseEnd (a double-invoked React updater,
   * a settle() that races itself on wake) collapses onto the same row instead
   * of duplicating it. Cheaper than any dedupe we'd otherwise have to write.
   */
  id: string
  /** When the block first started running. */
  startedAt: number
  /** When it completed, or when it was abandoned. */
  endedAt: number
  /** The block length it set out to do. */
  plannedMs: number
  /** Time actually spent focused — excludes pauses. See PhaseEnd.elapsedMs. */
  focusedMs: number
  outcome: SessionOutcome
  /**
   * Reserved for TES-5 (task attachment). Always null today. It costs one field
   * now and saves migrating every row someone recorded this week later.
   */
  taskId: string | null
}

/**
 * Start a block, change your mind, hit Reset — that is a misclick, not history.
 * Below this, an abandoned block is treated as a false start and dropped.
 *
 * Only ever applies to abandonments. A *completed* block is always recorded, no
 * matter how short, and cannot trip this floor anyway: the shortest configurable
 * phase is a minute (MIN_PHASE_MS).
 */
export const MIN_ABANDONED_MS = 30_000

/**
 * Hard cap on rows. At ~120 bytes each this is well under a megabyte, and at a
 * realistic ten focus blocks a day it is over two years of history — long
 * enough that pruning is a theoretical concern, bounded enough that we can
 * never blow the localStorage quota. Oldest go first.
 */
export const MAX_SESSIONS = 5_000

/**
 * Which phase-ends become history.
 *
 * Focus blocks only. Breaks are not work, and logging them would put noise in
 * the history list and, worse, in "focus time today". The engine emits them
 * anyway (the completion banner needs them) — filtering is this module's job.
 */
export function isRecordable(end: PhaseEnd): boolean {
  if (end.phase !== 'focus') return false
  if (end.outcome === 'abandoned' && end.elapsedMs < MIN_ABANDONED_MS) return false
  return true
}

export function sessionFrom(end: PhaseEnd): Session {
  return {
    id: `${end.startedAt}-${end.endedAt}`,
    startedAt: end.startedAt,
    endedAt: end.endedAt,
    plannedMs: end.plannedMs,
    focusedMs: end.elapsedMs,
    outcome: end.outcome,
    taskId: null,
  }
}

/**
 * Prepend a session, newest first. Idempotent by id (see Session.id), and
 * identity-stable on a no-op so React re-renders and the save effect don't fire
 * for a write that didn't happen.
 */
export function addSession(list: Session[], session: Session): Session[] {
  if (list.some((s) => s.id === session.id)) return list
  return [session, ...list].slice(0, MAX_SESSIONS)
}

/** Record a phase-end if it qualifies. The one entry point the app should use. */
export function record(list: Session[], end: PhaseEnd | null): Session[] {
  if (!end || !isRecordable(end)) return list
  return addSession(list, sessionFrom(end))
}

// ---------------------------------------------------------------------------
// Parsing. What's on disk is input, not memory: it survives deploys, it can be
// hand-edited, and one bad row must not cost you the other four hundred.
// ---------------------------------------------------------------------------

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function parseSession(raw: unknown): Session | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>

  const { startedAt, endedAt, plannedMs, focusedMs } = s
  if (!isFiniteNum(startedAt) || !isFiniteNum(endedAt)) return null
  // Time does not run backwards. A row claiming otherwise is corrupt, and a
  // negative duration would poison every sum computed over it.
  if (endedAt < startedAt) return null
  if (!isFiniteNum(plannedMs) || plannedMs <= 0) return null
  if (!isFiniteNum(focusedMs) || focusedMs < 0) return null
  if (s.outcome !== 'completed' && s.outcome !== 'abandoned') return null

  return {
    id: typeof s.id === 'string' && s.id ? s.id : `${startedAt}-${endedAt}`,
    startedAt,
    endedAt,
    // You cannot have focused for longer than the block was ever going to be.
    focusedMs: Math.min(focusedMs, plannedMs),
    plannedMs,
    outcome: s.outcome,
    taskId: typeof s.taskId === 'string' ? s.taskId : null,
  }
}

/** Drop unusable rows, keep the rest. Newest first, deduped, capped. */
export function parseSessions(raw: unknown): Session[] {
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const out: Session[] = []
  for (const row of raw) {
    const session = parseSession(row)
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    out.push(session)
  }

  out.sort((a, b) => b.endedAt - a.endedAt)
  return out.slice(0, MAX_SESSIONS)
}

export function deserializeSessions(json: string | null): Session[] {
  if (!json) return []
  try {
    return parseSessions(JSON.parse(json))
  } catch {
    return []
  }
}

export function serializeSessions(list: Session[]): string {
  return JSON.stringify(list)
}

// ---------------------------------------------------------------------------
// Reading history. Enough for a list grouped by day; the real stats (streaks,
// per-week rollups) are TES-6 and belong in their own module.
// ---------------------------------------------------------------------------

/**
 * Local-calendar day key, e.g. "2026-07-13". Local, not UTC: a session at 11pm
 * belongs to the day you were sitting in, not to tomorrow in Greenwich.
 */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export type DayGroup = {
  key: string
  /** Any instant inside the day — for formatting the heading. */
  at: number
  sessions: Session[]
  focusedMs: number
  completed: number
}

/** Group newest-first sessions into newest-first days. Preserves input order. */
export function groupByDay(sessions: Session[]): DayGroup[] {
  const groups = new Map<string, DayGroup>()

  for (const s of sessions) {
    const key = dayKey(s.endedAt)
    let group = groups.get(key)
    if (!group) {
      group = { key, at: s.endedAt, sessions: [], focusedMs: 0, completed: 0 }
      groups.set(key, group)
    }
    group.sessions.push(s)
    group.focusedMs += s.focusedMs
    if (s.outcome === 'completed') group.completed += 1
  }

  return [...groups.values()]
}

/** Focus time banked on the calendar day containing `now`. */
export function focusedOn(sessions: Session[], now: number): number {
  const key = dayKey(now)
  return sessions.reduce((sum, s) => (dayKey(s.endedAt) === key ? sum + s.focusedMs : sum), 0)
}

/** "1h 15m", "25m", "40s" — for durations, where mm:ss would read as a countdown. */
export function formatFocusTime(ms: number): string {
  // Test sub-minute on the raw value, not on rounded minutes: rounding first
  // turns 40 seconds into "1m", which overstates the one number this app exists
  // to keep honestly. Floor the seconds so we can never print "60s" either.
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`

  const totalMinutes = Math.round(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (!hours) return `${minutes}m`
  if (!minutes) return `${hours}h`
  return `${hours}h ${minutes}m`
}

/** "09:05" in the viewer's own timezone. */
export function formatClockTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * The calendar day before the one containing `ts`.
 *
 * Deliberately NOT `ts - 86_400_000`: a day is not always 24 hours. On the
 * Monday after a spring-forward, subtracting 24 hours from 00:30 lands on
 * *Saturday* 23:30, and Sunday would never be labelled "Yesterday". Stepping
 * the date field asks the calendar instead of assuming.
 */
function previousDayKey(ts: number): string {
  const d = new Date(ts)
  d.setDate(d.getDate() - 1)
  return dayKey(d.getTime())
}

/** "Today" / "Yesterday" / "Mon 13 Jul", relative to `now`. */
export function formatDayHeading(at: number, now: number): string {
  const key = dayKey(at)
  if (key === dayKey(now)) return 'Today'
  if (key === previousDayKey(now)) return 'Yesterday'

  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}
