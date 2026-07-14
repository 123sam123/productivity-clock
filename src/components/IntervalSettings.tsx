import { MINUTE_MS, type TimerConfig } from '../lib/timer.ts'
import { MAX_PHASE_MS, MIN_PHASE_MS, clampPhaseMs } from '../lib/persist.ts'

type Props = {
  config: TimerConfig
  onChange: (config: TimerConfig) => void
  /** Editing durations mid-phase only affects later phases; say so rather than hiding it. */
  locked: boolean
}

type Preset = { label: string; focus: number; short: number }

const PRESETS: Preset[] = [
  { label: '25 / 5', focus: 25, short: 5 },
  { label: '50 / 10', focus: 50, short: 10 },
  { label: '90 / 20', focus: 90, short: 20 },
]

const toMinutes = (ms: number) => Math.round(ms / MINUTE_MS)
const MIN_MIN = toMinutes(MIN_PHASE_MS)
const MAX_MIN = toMinutes(MAX_PHASE_MS)

export function IntervalSettings({ config, onChange, locked }: Props) {
  const set = (patch: Partial<TimerConfig>) => onChange({ ...config, ...patch })

  const minutesField = (
    key: 'focusMs' | 'shortBreakMs' | 'longBreakMs',
    label: string,
    testId: string,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={MIN_MIN}
        max={MAX_MIN}
        value={toMinutes(config[key])}
        data-testid={testId}
        onChange={(e) => {
          const minutes = Number(e.target.value)
          // An empty or half-typed field yields NaN; hold the last good value
          // rather than letting NaN reach the engine.
          if (!Number.isFinite(minutes)) return
          set({ [key]: clampPhaseMs(minutes * MINUTE_MS) })
        }}
      />
      <span className="unit">min</span>
    </label>
  )

  const activePreset = PRESETS.find(
    (p) => p.focus * MINUTE_MS === config.focusMs && p.short * MINUTE_MS === config.shortBreakMs,
  )

  return (
    <section className="settings" aria-label="Interval settings">
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`chip${activePreset?.label === p.label ? ' chip-active' : ''}`}
            aria-pressed={activePreset?.label === p.label}
            data-testid={`preset-${p.focus}`}
            onClick={() => set({ focusMs: p.focus * MINUTE_MS, shortBreakMs: p.short * MINUTE_MS })}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="fields">
        {minutesField('focusMs', 'Focus', 'cfg-focus')}
        {minutesField('shortBreakMs', 'Short break', 'cfg-short')}
        {minutesField('longBreakMs', 'Long break', 'cfg-long')}
        <label className="field">
          <span>Long break every</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={12}
            value={config.longBreakEvery}
            data-testid="cfg-cadence"
            onChange={(e) => {
              const n = Number(e.target.value)
              if (!Number.isFinite(n)) return
              set({ longBreakEvery: Math.min(12, Math.max(1, Math.round(n))) })
            }}
          />
          <span className="unit">focus blocks</span>
        </label>
      </div>

      {locked && (
        <p className="settings-note" data-testid="settings-note">
          The phase in progress keeps the length it started with — changes apply from the next
          phase.
        </p>
      )}
    </section>
  )
}
