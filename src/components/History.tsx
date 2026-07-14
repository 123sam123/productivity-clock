import {
  dayKey,
  formatClockTime,
  formatDayHeading,
  formatFocusTime,
  groupByDay,
  type Session,
} from '../lib/sessions.ts'

/**
 * Recent sessions, newest first, grouped by the day they ended on.
 *
 * "Recent" is load-bearing: history is capped at MAX_SESSIONS on disk, but
 * rendering years of it into the DOM would be silly and unreadable. We show the
 * most recent RECENT_LIMIT and say plainly how many more are being held —
 * silently truncating would read as "that's all you've done", which is a lie
 * about the one number this app exists to keep. The full rollups are TES-6.
 */
const RECENT_LIMIT = 20

type Props = {
  sessions: Session[]
  focusedToday: number
  /** Passed in rather than read here, so "Today" means the same thing app-wide. */
  now: number
}

export function History({ sessions, focusedToday, now }: Props) {
  const recent = sessions.slice(0, RECENT_LIMIT)
  const hidden = sessions.length - recent.length

  const today = dayKey(now)
  const completedToday = sessions.filter(
    (s) => s.outcome === 'completed' && dayKey(s.endedAt) === today,
  ).length

  return (
    <section className="history" aria-label="Session history" data-testid="history">
      <header className="history-header">
        <h2>History</h2>
        <p className="history-today" data-testid="today-focus">
          {focusedToday > 0 ? (
            <>
              <strong>{formatFocusTime(focusedToday)}</strong> focused today
              {completedToday > 0 && ` · ${completedToday} completed`}
            </>
          ) : (
            'nothing logged today — yet'
          )}
        </p>
      </header>

      {sessions.length === 0 ? (
        <p className="history-empty" data-testid="history-empty">
          No sessions yet. Finish a focus block and it lands here — and stays, across reloads and
          restarts.
        </p>
      ) : (
        <>
          {groupByDay(recent).map((day) => (
            <div className="history-day" key={day.key} data-testid="history-day">
              <div className="history-day-header">
                <span className="history-day-name">{formatDayHeading(day.at, now)}</span>
                <span className="history-day-total">{formatFocusTime(day.focusedMs)}</span>
              </div>

              <ol className="history-list">
                {day.sessions.map((s) => (
                  <li
                    className={`history-row outcome-${s.outcome}`}
                    key={s.id}
                    data-testid="session-row"
                    data-outcome={s.outcome}
                  >
                    <span className="history-when">
                      <time dateTime={new Date(s.startedAt).toISOString()}>
                        {formatClockTime(s.startedAt)}
                      </time>
                      <span aria-hidden="true"> – </span>
                      <time dateTime={new Date(s.endedAt).toISOString()}>
                        {formatClockTime(s.endedAt)}
                      </time>
                    </span>

                    <span className="history-duration" data-testid="session-duration">
                      {formatFocusTime(s.focusedMs)}
                    </span>

                    <span className="history-outcome">
                      {s.outcome === 'completed' ? (
                        <span className="tag tag-done">completed</span>
                      ) : (
                        // An abandoned block still shows the time you actually put
                        // in. You did the minutes; they just didn't reach the bell.
                        <span className="tag tag-abandoned">
                          abandoned of {formatFocusTime(s.plannedMs)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}

          {hidden > 0 && (
            <p className="history-more" data-testid="history-more">
              + {hidden} earlier {hidden === 1 ? 'session' : 'sessions'} kept
            </p>
          )}
        </>
      )}
    </section>
  )
}
