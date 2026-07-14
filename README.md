# productivity clock

A focus timer you keep open while you work. React + TypeScript + Vite, local-first, no backend.

**Live:** https://123sam123.github.io/productivity-clock/

## Status

Timer engine (TES-3) and sessions + local-first history (TES-4) are live. Pomodoro and custom
intervals, start/pause/resume/reset/skip, and every focus block recorded to a history that
survives reload and browser restart. Tasks (TES-5) and stats (TES-6) are next.

## Timer correctness

The one thing this app cannot get wrong. Remaining time is **always derived from a wall-clock
target** (`targetAt - Date.now()`), never accumulated from `setInterval` ticks. The interval only
decides when to re-render; browsers throttle timers in background tabs, so a tick-counting timer
silently loses time. `useTimer` also resyncs on `visibilitychange`, so a tab returning to the
foreground updates immediately instead of waiting for the next throttled tick.

The engine (`src/lib/timer.ts`) never reads the clock at all — `now` is always an argument. That
makes a three-hour laptop sleep an ordinary function call in a test.

This is verified, not assumed — see below.

## Sessions and history

Every **focus block** becomes a session: start, end, planned length, time actually focused, and an
outcome of `completed` or `abandoned`. Breaks are not sessions — history is a record of focus, not
of resting.

Three rules make the numbers trustworthy:

- **Pausing is not focusing.** A 25-minute block you paused for an hour in the middle of banks 25
  minutes of focus, not 85. Time spent paused never moved the deadline, so it never inflates the
  total.
- **A block is dated when it truly ended**, not when we noticed. Finish a pomodoro while the lid is
  shut and it is recorded at its real deadline, even if you reopen three hours later.
- **A misclick is not history.** Start a block and reset it seconds later and nothing is written.

Persistence is **localStorage**, under its own key (`clock.sessions.v1`), separate from the timer's.
A session is ~120 bytes: even a punishing sixteen-pomodoro day is under 3 KB a week, nowhere near
the ~5 MB budget, and history is capped at 5,000 rows. IndexedDB would buy async writes, a larger
quota and range queries — none of which we need for a list we read once at load and hold in memory.
What localStorage buys is that it is *synchronous*: history is on screen in the first paint, with no
spinner and no flash of an empty list. On a clock you reload without thinking, that is the whole
user-visible difference. What's on disk is treated as untrusted input — a corrupt row is dropped,
and the rest of your history still loads.

## Commands

```bash
npm install
npm run dev              # http://localhost:5173/productivity-clock/
npm run build            # tsc -b && vite build
npm run preview          # serve the production bundle
npm test                 # engine + session unit tests
npm run verify           # both browser suites below (~3 min)
npm run verify:timer     # timer correctness in a real browser (~70s)
npm run verify:sessions  # sessions, history, browser restart (~90s)
```

Both `verify` scripts drive the **production bundle** in a real Chromium. Screenshots land in
`evidence/`.

`verify:timer` starts the timer and **suppresses every tick for 65 seconds of real elapsed time**,
then asserts the countdown is still accurate. It runs the forbidden tick-counting implementation
alongside ours in the same page as a control — that one comes back a full minute wrong.

`verify:sessions` records completed, abandoned and false-start blocks, then **closes the browser
completely and relaunches a new process against the same on-disk profile** to prove history
survives a restart rather than merely a reload (a normal Playwright context is incognito, which
would make that test vacuous). It ends with a real 60-second block whose deadline passes while the
page receives *zero* ticks — and which is still recorded as exactly 60,000 ms of focus.

Note the base path: the app is served under `/productivity-clock/` in dev, preview and production
alike, so the deployed URL shape is reproduced locally.

## Deploy

Push to `main` → GitHub Actions builds and publishes to GitHub Pages (`.github/workflows/deploy.yml`).
