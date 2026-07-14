# productivity clock

A focus timer you keep open while you work. React + TypeScript + Vite, local-first, no backend.

**Live:** https://123sam123.github.io/productivity-clock/

## Status

Skeleton (TES-2). The clock face renders and counts down from 25:00, with start and reset.
The real timer engine — pause/resume/skip, custom intervals, sessions, tasks, history and
stats — lands in follow-up issues.

## Timer correctness

The one thing this app cannot get wrong. Remaining time is **always derived from a wall-clock
target** (`targetAt - Date.now()`), never accumulated from `setInterval` ticks. The interval only
decides when to re-render; browsers throttle timers in background tabs, so a tick-counting timer
silently loses time. `useCountdown` also resyncs on `visibilitychange`, so a tab returning to the
foreground updates immediately instead of waiting for the next throttled tick.

This is verified, not assumed — see below.

## Commands

```bash
npm install
npm run dev      # http://localhost:5173/productivity-clock/
npm run build    # tsc -b && vite build
npm run preview  # serve the production bundle
npm run verify   # drive the prod bundle in a real browser (~70s)
```

`npm run verify` launches Chromium against the production build, starts the timer, **backgrounds
the tab for 65 seconds of real elapsed time**, and asserts the countdown is still wall-clock
accurate on return. A tick-counting timer passes the "it counts down" check and fails this one.
Screenshots land in `evidence/`.

Note the base path: the app is served under `/productivity-clock/` in dev, preview and production
alike, so the deployed URL shape is reproduced locally.

## Deploy

Push to `main` → GitHub Actions builds and publishes to GitHub Pages (`.github/workflows/deploy.yml`).
