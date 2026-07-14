import { formatDuration, progress } from '../lib/time'

const RADIUS = 120
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

type Props = {
  remainingMs: number
  totalMs: number
}

export function ClockFace({ remainingMs, totalMs }: Props) {
  const dashOffset = CIRCUMFERENCE * progress(remainingMs, totalMs)

  return (
    <div className="clock-face">
      <svg viewBox="0 0 280 280" role="img" aria-label="Focus timer">
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
        <time data-testid="remaining" className="clock-time">
          {formatDuration(remainingMs)}
        </time>
        <span className="clock-label">focus</span>
      </div>
    </div>
  )
}
