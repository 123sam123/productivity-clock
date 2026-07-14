/**
 * Drives the production bundle in a real Chromium and asserts the countdown is
 * wall-clock accurate across everything that normally breaks a web timer:
 * a backgrounded tab, a page reload, a paused clock, and a sleeping machine.
 *
 * A tick-counting timer passes "it counts down" and fails every other check
 * here. That is the whole point of this script.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BACKGROUND TEST LOOKS THE WAY IT DOES
 *
 * The obvious test — open a second tab, wait 65s, come back — is a TRAP in
 * headless Chromium. Headless never marks the first tab `document.hidden`, so
 * it never throttles it, so the tab keeps ticking at full speed and the test
 * passes *no matter what the app does*. A tick-counting timer, the exact thing
 * this issue forbids, sails through it. We measured this: see the CONTROL below,
 * which reports whether the browser actually throttled. (Headless shell,
 * --headless=new, and headed all failed to hide the tab on this machine.)
 *
 * So we do not depend on the browser volunteering the fault. We INJECT it, and
 * we inject a strictly worse one: every interval callback in the page is
 * suspended for 65 seconds of real wall-clock time — ZERO ticks, where a real
 * throttled tab still gets roughly one per minute. A timer that survives having
 * its ticks taken away entirely survives having them merely rationed.
 *
 * Two things make this honest rather than a strawman:
 *
 *   1. We prove the fault landed: while suspended, the clock face must go STALE
 *      (the DOM stops updating). If it kept updating, the injection did nothing
 *      and the check would be vacuous — so we assert staleness.
 *
 *   2. We run the FORBIDDEN implementation next to ours, in the same page,
 *      under the same suspension: a counter that adds 200ms per tick. On resume
 *      it is ~65 seconds wrong, which is precisely how a tick-counting pomodoro
 *      ends up owing you twenty minutes. Ours is derived from the deadline and
 *      is right to the millisecond. That contrast is the actual result.
 *
 * Usage: node scripts/verify-timer.mjs [baseUrl]
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:4173/productivity-clock/'
const BACKGROUND_MS = 65_000
/** Render tick is 200ms; allow for scheduling jitter and CI slowness. */
const TOLERANCE_MS = 1_500
const MIN = 60_000

const parse = (mmss) => {
  const [m, s] = mmss.split(':').map(Number)
  return (m * 60 + s) * 1000
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`)
}
/** Environment observations that must not silently pass or fail the run. */
const note = (name, detail) => console.log(`  NOTE  ${name}\n        ${detail}`)
const near = (actual, expected, tol = TOLERANCE_MS) => Math.abs(actual - expected) <= tol
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

/**
 * Wraps setInterval so the harness can take every tick away from the page and
 * give them back. Must run before the app's bundle, hence addInitScript.
 *
 * Also installs `__naive` — a countdown built the forbidden way (accumulate a
 * fixed step per tick). It is the control: it shares the page, the interval
 * rate, and the suspension, and differs from the app in exactly one respect —
 * where it gets its remaining time from.
 */
const INSTRUMENT = () => {
  const realSet = window.setInterval.bind(window)
  const realClear = window.clearInterval.bind(window)
  const live = new Map()
  let suspended = false
  let fakeId = -1

  window.setInterval = (fn, delay, ...args) => {
    if (suspended) {
      const id = fakeId--
      live.set(id, { fn, delay, args, realId: null })
      return id
    }
    const realId = realSet(fn, delay, ...args)
    live.set(realId, { fn, delay, args, realId })
    return realId
  }
  window.clearInterval = (id) => {
    const rec = live.get(id)
    if (rec && rec.realId !== null) realClear(rec.realId)
    live.delete(id)
    realClear(id)
  }

  /** Freeze the page's heartbeat: a maximally throttled background tab. */
  window.__suspendTicks = () => {
    suspended = true
    for (const rec of live.values()) {
      if (rec.realId !== null) {
        realClear(rec.realId)
        rec.realId = null
      }
    }
  }
  /** Tab is looked at again: re-arm the intervals and fire what the browser fires. */
  window.__resumeTicks = () => {
    suspended = false
    for (const rec of live.values()) {
      if (rec.realId === null) rec.realId = realSet(rec.fn, rec.delay, ...rec.args)
    }
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  }

  window.__naive = { remainingMs: 25 * 60_000, startedAt: null }
  window.__startNaive = () => {
    window.__naive.startedAt = Date.now()
    // THE BUG, on purpose: time is accumulated from ticks, never read from the clock.
    window.setInterval(() => {
      window.__naive.remainingMs -= 200
    }, 200)
  }
}

const browser = await chromium.launch({
  // Playwright ships these ON, which makes hidden tabs behave like foreground
  // ones. Strip them so that IF the browser is willing to throttle, it will.
  ignoreDefaultArgs: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
})
const errors = []
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return page
}

// ---------------------------------------------------------------------------
// Part 1 — foreground and reload
// ---------------------------------------------------------------------------
console.log('\n▸ real-time checks (foreground, reload)\n')

const context = await browser.newContext()
const page = watch(await context.newPage())
await page.addInitScript(INSTRUMENT)
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })

const readout = page.getByTestId('remaining')
const phase = page.getByTestId('phase')
const status = page.getByTestId('status')
const remaining = async () => parse(await readout.textContent())

check(
  'clock face renders a full focus phase at rest',
  (await readout.textContent()) === '25:00' && (await phase.textContent()) === 'focus',
  `displayed ${await readout.textContent()} / ${await phase.textContent()}, expected 25:00 / focus`,
)
await page.screenshot({ path: 'evidence/01-idle.png' })

await page.getByRole('button', { name: 'Start focus' }).click()
const startedAt = Date.now()
await page.evaluate(() => window.__startNaive())
const elapsed = () => Date.now() - startedAt

await page.waitForTimeout(3000)
check(
  'countdown decrements while foregrounded',
  near(await remaining(), 25 * MIN - elapsed()),
  `displayed ${await readout.textContent()}, expected ~${secs(25 * MIN - elapsed())}`,
)
await page.screenshot({ path: 'evidence/02-running.png' })

// Reload mid-session. The deadline is persisted, so the reload is invisible.
// (This also drops the instrumentation's naive counter; it is re-armed after.)
await page.reload({ waitUntil: 'networkidle' })
check(
  'survives a page reload mid-session',
  near(await remaining(), 25 * MIN - elapsed()) && (await status.textContent()) === 'running',
  `displayed ${await readout.textContent()} (status ${await status.textContent()}), expected ~${secs(25 * MIN - elapsed())} and still running`,
)
await page.screenshot({ path: 'evidence/03-after-reload.png' })

// ---------------------------------------------------------------------------
// Part 2 — THE test: 65 real seconds with the page's heartbeat taken away.
// ---------------------------------------------------------------------------
console.log('\n▸ backgrounded tab: 65 real seconds with every tick suppressed\n')

await page.evaluate(() => window.__startNaive())
const naiveArmedAt = Date.now()

// Is this browser willing to throttle a hidden tab on its own? Informational:
// if it is, great; if it isn't, the injected suspension below is harsher anyway.
const distraction = await context.newPage()
await distraction.goto('about:blank')
await distraction.bringToFront()
await page.waitForTimeout(1500)
const hid = await page.evaluate(() => document.hidden)
await page.bringToFront()
await distraction.close()
note(
  'CONTROL: does this browser throttle a hidden tab by itself?',
  hid
    ? 'yes — document.hidden went true, so the browser would throttle on its own.'
    : 'NO — headless Chromium never marks the tab hidden, so a "switch tabs and wait" test would ' +
      'be vacuous here (a tick-counting timer would pass it too). Injecting the fault instead, below.',
)

const beforeSuspend = await readout.textContent()
await page.evaluate(() => window.__suspendTicks())

// Did the fault actually land? If the DOM keeps updating, nothing was suppressed
// and every conclusion below would be worthless.
await page.waitForTimeout(4000)
const duringSuspend = await readout.textContent()
check(
  'the injected fault is real: with ticks suppressed, the clock face goes stale',
  beforeSuspend === duringSuspend,
  `readout held at ${duringSuspend} across 4s of real time with zero interval callbacks ` +
    `(a live tab would have repainted ~20 times). The page is genuinely not ticking.`,
)

console.log(`\n  … holding for the rest of ${BACKGROUND_MS / 1000}s of real time, still not ticking\n`)
await page.waitForTimeout(BACKGROUND_MS - 4000)

// The tab is looked at again: re-arm intervals, fire visibilitychange + focus.
await page.evaluate(() => window.__resumeTicks())
await page.waitForTimeout(400)

const afterBg = await remaining()
const expectedBg = 25 * MIN - elapsed()
check(
  'survives 65s of a fully throttled tab with no drift',
  near(afterBg, expectedBg),
  `displayed ${await readout.textContent()}, expected ~${secs(expectedBg)}, drift ${Math.abs(afterBg - expectedBg)}ms ` +
    `— recomputed from the stored deadline, so the missing ticks cost nothing.`,
)
await page.screenshot({ path: 'evidence/04-after-background.png' })

// And the same suspension, applied to the implementation this issue forbids.
const naive = await page.evaluate(() => window.__naive.remainingMs)
const naiveTruth = 25 * MIN - (Date.now() - naiveArmedAt)
const naiveDrift = naive - naiveTruth
check(
  'CONTROL: the forbidden tick-counting timer loses ~a minute across the same suspension',
  naiveDrift > 55_000,
  `the tick-counter believes ${secs(naive)} remain; only ${secs(naiveTruth)} really do. ` +
    `It silently GAINED ${secs(naiveDrift)} it never earned — this is the bug we are guarding against, ` +
    `reproduced in the same tab, under the same conditions, in the same run.`,
)

// ---------------------------------------------------------------------------
// Part 3 — pause, resume, skip, custom intervals
// ---------------------------------------------------------------------------
console.log('\n▸ controls (pause, resume, skip, custom intervals)\n')

await page.getByRole('button', { name: 'Pause' }).click()
const atPause = await remaining()
await page.waitForTimeout(4000)
const afterHold = await remaining()
check(
  'pause freezes the clock',
  atPause === afterHold && (await status.textContent()) === 'paused',
  `held at ${await readout.textContent()} across 4s (status ${await status.textContent()})`,
)
await page.screenshot({ path: 'evidence/05-paused.png' })

await page.getByRole('button', { name: 'Resume' }).click()
const resumedAt = Date.now()
await page.waitForTimeout(2500)
check(
  'resume continues from where it stopped, losing only the time actually spent running',
  near(await remaining(), afterHold - (Date.now() - resumedAt)),
  `displayed ${await readout.textContent()}, expected ~${secs(afterHold - (Date.now() - resumedAt))}`,
)

await page.getByRole('button', { name: 'Skip' }).click()
check(
  'skip advances to the break without counting the abandoned focus block',
  (await phase.textContent()) === 'short break' &&
    (await readout.textContent()) === '05:00' &&
    (await page.getByTestId('focus-count').textContent()).includes('0 done'),
  `phase ${await phase.textContent()}, clock ${await readout.textContent()}, ${await page.getByTestId('focus-count').textContent()}`,
)

await page.getByTestId('preset-50').click()
check(
  'custom interval (50/10 preset) applies to the idle phase',
  (await readout.textContent()) === '10:00',
  `short break now displays ${await readout.textContent()}, expected 10:00`,
)
await page.getByTestId('cfg-short').fill('7')
check(
  'custom interval (typed value) applies to the idle phase',
  (await readout.textContent()) === '07:00',
  `short break now displays ${await readout.textContent()}, expected 07:00`,
)
await page.screenshot({ path: 'evidence/06-custom-interval.png' })

await context.close()

// ---------------------------------------------------------------------------
// Part 4 — machine sleep/wake, via a controllable clock.
// Playwright's clock.fastForward() jumps time without firing the timers that
// were due during the jump: exactly what a closed laptop lid does to a tab.
// ---------------------------------------------------------------------------
console.log('\n▸ sleep/wake checks (clock jumped forward, timers not fired during the jump)\n')

const sleepCtx = await browser.newContext()
const sleepPage = watch(await sleepCtx.newPage())
await sleepPage.clock.install({ time: new Date('2026-07-13T09:00:00Z') })
await sleepPage.goto(BASE, { waitUntil: 'networkidle' })
await sleepPage.evaluate(() => localStorage.clear())
await sleepPage.reload({ waitUntil: 'networkidle' })

const sleepReadout = sleepPage.getByTestId('remaining')
const sleepPhase = sleepPage.getByTestId('phase')
const sleepCount = sleepPage.getByTestId('focus-count')

await sleepPage.getByRole('button', { name: 'Start focus' }).click()

// Lid shut for 10 minutes, mid-session.
await sleepPage.clock.fastForward(10 * MIN)
await sleepPage.waitForTimeout(300)
check(
  'machine sleeps 10 min mid-session: countdown is correct on wake',
  (await sleepReadout.textContent()) === '15:00',
  `displayed ${await sleepReadout.textContent()} after a 10 min sleep, expected 15:00`,
)
await sleepPage.screenshot({ path: 'evidence/07-after-sleep.png' })

// Lid shut again, this time straight past the end of the focus block.
await sleepPage.clock.fastForward(20 * MIN)
await sleepPage.waitForTimeout(300)
check(
  'a phase that ended during sleep completes, and lands on the break',
  (await sleepPhase.textContent()) === 'short break' &&
    (await sleepReadout.textContent()) === '05:00' &&
    (await sleepCount.textContent()).includes('1 done'),
  `phase ${await sleepPhase.textContent()}, clock ${await sleepReadout.textContent()}, ${await sleepCount.textContent()}`,
)
check(
  'the completed phase is announced on return',
  await sleepPage.getByTestId('completion-banner').isVisible(),
  `banner: "${await sleepPage.getByTestId('completion-banner').textContent()}"`,
)
await sleepPage.screenshot({ path: 'evidence/08-completed-during-sleep.png' })

// Sleeping through the afternoon must not invent work you never did.
await sleepPage.clock.fastForward(4 * 60 * MIN)
await sleepPage.waitForTimeout(300)
check(
  'sleeping for 4 more hours does not chain-complete phases nobody worked',
  (await sleepCount.textContent()).includes('1 done') &&
    (await sleepPhase.textContent()) === 'short break',
  `still ${await sleepCount.textContent()} on the ${await sleepPhase.textContent()} — idle phases have no deadline to trip`,
)

check('no console or page errors anywhere', errors.length === 0, errors.join('; ') || 'none')

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length ? 1 : 0)
