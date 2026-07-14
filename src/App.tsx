import { useState } from 'react'
import { ClockFace } from './components/ClockFace'
import { useCountdown } from './hooks/useCountdown'
import { MINUTE_MS } from './lib/time'
import './App.css'

const FOCUS_MS = 25 * MINUTE_MS

export default function App() {
  const [targetAt, setTargetAt] = useState<number | null>(null)
  const remaining = useCountdown(targetAt)
  const running = targetAt !== null

  return (
    <main className="app">
      <header className="app-header">
        <h1>test clock</h1>
        <p className="tagline">a focus timer you keep open while you work</p>
      </header>

      <ClockFace remainingMs={running ? remaining : FOCUS_MS} totalMs={FOCUS_MS} />

      <div className="controls">
        {running ? (
          <button className="btn btn-ghost" onClick={() => setTargetAt(null)}>
            Reset
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => setTargetAt(Date.now() + FOCUS_MS)}
          >
            Start focus
          </button>
        )}
      </div>

      <footer className="app-footer">
        skeleton — timer engine, sessions and history next
      </footer>
    </main>
  )
}
