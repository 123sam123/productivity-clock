import { formatDuration, progress, PHASE_LABELS, type Phase, type TimerStatus } from '../lib/timer.ts'

const RADIUS = 120
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

type Props = {
  remainingMs: number
  totalMs: number
  phase: Phase
  status: TimerStatus
}

export function ClockFace({ remainingMs, totalMs, phase, status }: Props) {
  const dashOffset = CIRCUMFERENCE * progress(remainingMs, totalMs)

  return (
    <div className={`clock-face phase-${phase}`} data-status={status}>
      <svg viewBox="0 0 280 280" role="img" aria-label={`${PHASE_LABELS[phase]} timer`}>
        <circle className="clock-track" cx="140" cy="140" r={RADIUS} />
        <circle
          className="clock-progress"
          cx="140"
          cy="140"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <div className="clock-readout">
        {/* aria-live is off: announcing every passing second would be unusable
            with a screen reader. Phase changes are announced instead. */}
        <time data-testid="remaining" className="clock-time" aria-live="off">
          {formatDuration(remainingMs)}
        </time>
        <span className="clock-label" data-testid="phase">
          {PHASE_LABELS[phase]}
        </span>
      </div>
    </div>
  )
}
