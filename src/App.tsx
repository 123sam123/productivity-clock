import { useEffect } from 'react'
import { ClockFace } from './components/ClockFace'
import { IntervalSettings } from './components/IntervalSettings'
import { useTimer } from './hooks/useTimer'
import { formatDuration, PHASE_LABELS } from './lib/timer.ts'
import './App.css'

export default function App() {
  const {
    state,
    remainingMs,
    lastCompleted,
    start,
    pause,
    reset,
    skip,
    setConfig,
    dismissCompletion,
  } = useTimer()

  const { status, phase, phaseTotalMs, focusCount, config } = state
  const running = status === 'running'
  const idle = status === 'idle'

  // The tab title is the whole point of a timer you leave in a background tab —
  // it's the one thing you can still see when the tab is hidden.
  useEffect(() => {
    const label = PHASE_LABELS[phase]
    document.title = idle
      ? 'test clock'
      : `${formatDuration(remainingMs)} · ${label}${status === 'paused' ? ' (paused)' : ''}`
  }, [remainingMs, phase, status, idle])

  // Progress through the current pomodoro set, e.g. 2 of 4 before the long break.
  // During the long break itself the set is finished, so light every pip; the
  // next focus block starts a fresh set.
  const cadence = Math.max(1, config.longBreakEvery)
  const filledPips = phase === 'longBreak' ? cadence : focusCount % cadence

  return (
    <main className="app">
      <header className="app-header">
        <h1>test clock</h1>
        <p className="tagline">a focus timer you keep open while you work</p>
      </header>

      {lastCompleted && (
        <div className="banner" role="status" data-testid="completion-banner">
          <span>
            {PHASE_LABELS[lastCompleted.phase]} complete — {PHASE_LABELS[phase]} is up next
          </span>
          <button className="banner-dismiss" onClick={dismissCompletion} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <ClockFace
        remainingMs={remainingMs}
        totalMs={phaseTotalMs}
        phase={phase}
        status={status}
      />

      <div className="cycle" data-testid="focus-count" aria-label={`${focusCount} focus blocks completed`}>
        {Array.from({ length: cadence }, (_, i) => (
          <span key={i} className={`pip${i < filledPips ? ' pip-done' : ''}`} />
        ))}
        <span className="cycle-count">{focusCount} done</span>
      </div>

      <div className="controls">
        {running ? (
          <button className="btn btn-primary" onClick={pause}>
            Pause
          </button>
        ) : (
          <button className="btn btn-primary" onClick={start}>
            {status === 'paused' ? 'Resume' : `Start ${PHASE_LABELS[phase]}`}
          </button>
        )}
        <button className="btn btn-ghost" onClick={reset} disabled={idle}>
          Reset
        </button>
        <button className="btn btn-ghost" onClick={skip}>
          Skip
        </button>
      </div>

      <IntervalSettings config={config} onChange={setConfig} locked={!idle} />

      <footer className="app-footer">
        <span data-testid="status">{status}</span> · sessions &amp; history next
      </footer>
    </main>
  )
}
