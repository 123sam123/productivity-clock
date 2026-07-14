/**
 * Drives the production bundle in a real Chromium and proves that sessions are
 * recorded honestly and that history actually survives.
 *
 * ---------------------------------------------------------------------------
 * WHY A PERSISTENT PROFILE
 *
 * "History survives reload and browser restart" — a reload is easy and proves
 * little: same process, same renderer, localStorage never left memory. The
 * claim that can actually fail is the restart.
 *
 * So we don't use a normal Playwright context (which is incognito — it throws
 * its storage away and would make a restart test vacuous). We launch a
 * PERSISTENT profile on disk, do the work, CLOSE THE BROWSER COMPLETELY, and
 * then launch a brand new browser process against the same profile directory.
 * If history comes back, it came back off the disk, because there was nowhere
 * else for it to be.
 *
 * WHY THE CLOCK IS FAKED
 *
 * A real 25-minute pomodoro takes 25 minutes. Playwright's clock.fastForward()
 * jumps wall-clock time forward without firing the timers that were due during
 * the jump — which is precisely what a closed laptop lid does to a tab. That
 * makes it both a speed-up AND the harshest test of the engine's central claim:
 * the app never counts ticks, so taking its ticks away must not cost it a
 * second. Everything below is asserted against derived deadlines, not ticks.
 *
 * Usage: node scripts/verify-sessions.mjs [baseUrl]
 */
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:4173/productivity-clock/'
const MIN = 60_000

/**
 * Mid-morning UTC on purpose: far enough from midnight that ~5 hours of
 * fast-forwarding cannot roll the *local* calendar day over and turn "Today"
 * into "Yesterday" underneath the assertions, in whatever timezone this runs.
 */
const START_TIME = new Date('2026-07-13T16:00:00Z')

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}\n        ${detail}`)
}

const profile = mkdtempSync(join(tmpdir(), 'clock-profile-'))
const errors = []

/**
 * Freezes the page's heartbeat on demand — every interval callback is dropped,
 * which is a background tab throttled as hard as a browser can throttle one.
 * Must run before the app's bundle, hence addInitScript.
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

  window.__suspendTicks = () => {
    suspended = true
    for (const rec of live.values()) {
      if (rec.realId !== null) {
        realClear(rec.realId)
        rec.realId = null
      }
    }
  }
  window.__resumeTicks = () => {
    suspended = false
    for (const rec of live.values()) {
      if (rec.realId === null) rec.realId = realSet(rec.fn, rec.delay, ...rec.args)
    }
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  }
}

/**
 * Launch a browser against the profile on disk.
 *
 * `fakeClock` is how we stage a three-hour laptop sleep in milliseconds. Part 6
 * turns it OFF and runs against real wall-clock time, because a faked clock
 * could in principle flatter us — see the note there.
 */
const launch = async ({ fakeClock = true, instrument = false } = {}) => {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    // Playwright ships these ON, which makes hidden tabs behave like foreground
    // ones. Strip them so a throttled tab can actually be throttled.
    ignoreDefaultArgs: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  })
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  if (instrument) await page.addInitScript(INSTRUMENT)
  if (fakeClock) await page.clock.install({ time: START_TIME })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  return { context, page }
}

/** The history list as plain data: what a user would actually read off the screen. */
const history = (page) =>
  page.$$eval('[data-testid="session-row"]', (rows) =>
    rows.map((r) => ({
      when: r.querySelector('.history-when').textContent.trim(),
      duration: r.querySelector('.history-duration').textContent.trim(),
      outcome: r.dataset.outcome,
      label: r.querySelector('.history-outcome').textContent.trim(),
    })),
  )

const today = (page) => page.getByTestId('today-focus').textContent()
const rowCount = async (page) => (await history(page)).length

// ---------------------------------------------------------------------------
// Part 1 — what becomes a session, and what must not
// ---------------------------------------------------------------------------
console.log('\n▸ recording sessions (completed, abandoned, false starts, breaks)\n')

let { context, page } = await launch()
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })

check(
  'a clock with no history says so, rather than showing an empty box',
  await page.getByTestId('history-empty').isVisible(),
  `empty state: "${(await page.getByTestId('history-empty').textContent()).trim()}"`,
)
await page.screenshot({ path: 'evidence/10-history-empty.png', fullPage: true })

// --- a focus block run to completion -----------------------------------------
await page.getByRole('button', { name: 'Start focus' }).click()
await page.clock.fastForward(25 * MIN)
await page.waitForTimeout(300)

let rows = await history(page)
check(
  'a focus block run to zero is recorded, for its full length',
  rows.length === 1 && rows[0].outcome === 'completed' && rows[0].duration === '25m',
  `history: ${JSON.stringify(rows)}`,
)
// The row shows a start and an end in the viewer's own timezone, so assert on
// the SPAN between them rather than on literal digits — the span is the claim,
// and it holds wherever this runs.
const span = (when) => {
  const [a, b] = when.split('–').map((t) => t.trim())
  const mins = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1])
  return (mins(b) - mins(a) + 1440) % 1440
}
check(
  'the session is stamped with the wall-clock window it actually occupied',
  span(rows[0].when) === 25,
  `row reads "${rows[0].when}" — start to end is ${span(rows[0].when)} minutes`,
)

// --- a completed BREAK, which is not work and must not be logged --------------
await page.getByRole('button', { name: 'Start short break' }).click()
await page.clock.fastForward(5 * MIN)
await page.waitForTimeout(300)

check(
  'a completed break is NOT a session — history is a record of focus, not of resting',
  (await rowCount(page)) === 1,
  `still ${await rowCount(page)} row after taking a full 5 minute break`,
)

// --- abandoning a focus block mid-flight --------------------------------------
await page.getByRole('button', { name: 'Start focus' }).click()
await page.clock.fastForward(10 * MIN)
await page.getByRole('button', { name: 'Skip' }).click()
await page.waitForTimeout(300)

rows = await history(page)
check(
  'skipping a focus block records what you actually did, as abandoned',
  rows.length === 2 && rows[0].outcome === 'abandoned' && rows[0].duration === '10m',
  `newest row: ${JSON.stringify(rows[0])}`,
)
check(
  'an abandoned block is honest about the block it walked away from',
  rows[0].label.includes('25m'),
  `row reads "${rows[0].label}" — 10 minutes done of a 25 minute block`,
)

// --- a false start ------------------------------------------------------------
// Skip the break we just landed on, then start a focus block and bail instantly.
await page.getByRole('button', { name: 'Skip' }).click()
await page.getByRole('button', { name: 'Start focus' }).click()
await page.clock.fastForward(5_000)
await page.getByRole('button', { name: 'Reset' }).click()
await page.waitForTimeout(300)

check(
  'a start-then-immediately-reset is a misclick, not history',
  (await rowCount(page)) === 2,
  `still ${await rowCount(page)} rows after starting a block and resetting it 5 seconds in`,
)

// ---------------------------------------------------------------------------
// Part 2 — the numbers have to be true
// ---------------------------------------------------------------------------
console.log('\n▸ the recorded numbers (pause must not inflate focus time)\n')

await page.getByRole('button', { name: 'Start focus' }).click()
await page.clock.fastForward(10 * MIN)
await page.getByRole('button', { name: 'Pause' }).click()
await page.clock.fastForward(60 * MIN) // an hour at lunch, mid-pomodoro
await page.getByRole('button', { name: 'Resume' }).click()
await page.clock.fastForward(15 * MIN) // the 15 minutes that were left
await page.waitForTimeout(300)

rows = await history(page)
check(
  'an hour spent on pause is not an hour of focus',
  rows.length === 3 && rows[0].outcome === 'completed' && rows[0].duration === '25m',
  `the block spanned 85 minutes of wall clock but banked ${rows[0].duration} of focus — ` +
    `paused time is not focused time`,
)

check(
  "today's total is the sum of the focus actually done, abandoned blocks included",
  (await today(page)).includes('1h'),
  `header reads "${(await today(page)).trim()}" — 25m + 10m abandoned + 25m = 1h`,
)

// ---------------------------------------------------------------------------
// Part 3 — a block that ends while nobody is watching
// ---------------------------------------------------------------------------
console.log('\n▸ a focus block that ends while the machine is asleep\n')

await page.getByRole('button', { name: 'Skip' }).click() // off the break
await page.getByRole('button', { name: 'Start focus' }).click()

// Lid shut. Opened three hours later — long after the block's deadline passed.
await page.clock.fastForward(3 * 60 * MIN)
await page.waitForTimeout(300)

rows = await history(page)

// Read the stored row and the page's idea of "now" together. Asserting on the
// row's OWN timestamps (rather than on a Date.now() we sampled around the click,
// which is a few ms off by construction) states the actual claim exactly.
const { session, noticedAt } = await page.evaluate(() => ({
  session: JSON.parse(localStorage.getItem('clock.sessions.v1'))[0],
  noticedAt: Date.now(),
}))
const lateBy = noticedAt - session.endedAt

check(
  'a block that ended during a 3 hour sleep is recorded, once',
  rows.length === 4 && rows[0].outcome === 'completed' && rows[0].duration === '25m',
  `history: ${rows.length} rows, newest ${JSON.stringify(rows[0])}`,
)
check(
  'and it is dated when it TRULY ended, not when we happened to notice',
  session.endedAt - session.startedAt === 25 * MIN && lateBy > 2.5 * 60 * MIN,
  `the row spans exactly ${(session.endedAt - session.startedAt) / MIN} minutes and is dated ` +
    `${new Date(session.endedAt).toISOString()} — its true deadline. We did not look until ` +
    `${(lateBy / MIN).toFixed(0)} minutes after that. A tick-counting timer would have dated it ` +
    `on our return and quietly owed us back the 2h35m it never wrote.`,
)

await page.screenshot({ path: 'evidence/11-history-populated.png', fullPage: true })
const before = await history(page)
const beforeToday = (await today(page)).trim()

// ---------------------------------------------------------------------------
// Part 4 — survival. Reload first (easy), then a real restart (the actual claim).
// ---------------------------------------------------------------------------
console.log('\n▸ survival: reload, then a genuine browser restart\n')

await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(300)

check(
  'history survives a page reload, unchanged',
  JSON.stringify(await history(page)) === JSON.stringify(before),
  `all ${before.length} rows identical across the reload`,
)

// Close the browser COMPLETELY. Not a new tab, not a new context — the process
// is gone. Anything that comes back now came back off the disk.
await context.close()
console.log('\n  … browser closed. Relaunching a new process against the same profile.\n')
;({ context, page } = await launch())
await page.waitForTimeout(300)

const after = await history(page)
check(
  'history survives a full browser restart — new process, same profile on disk',
  JSON.stringify(after) === JSON.stringify(before),
  `all ${after.length} sessions came back byte-identical from localStorage after the browser ` +
    `was shut down and relaunched: ${JSON.stringify(after.map((r) => `${r.duration} ${r.outcome}`))}`,
)
check(
  "and the day's total is recomputed from them correctly",
  (await today(page)).trim() === beforeToday,
  `header reads "${(await today(page)).trim()}", same as before the restart`,
)

await page.screenshot({ path: 'evidence/12-history-after-restart.png', fullPage: true })

// ---------------------------------------------------------------------------
// Part 5 — a corrupt blob must cost you the bad rows and nothing else
// ---------------------------------------------------------------------------
console.log('\n▸ a hand-edited / corrupt history blob\n')

await page.evaluate(() => {
  const good = JSON.parse(localStorage.getItem('clock.sessions.v1'))
  localStorage.setItem(
    'clock.sessions.v1',
    JSON.stringify([good[0], null, 'garbage', { startedAt: 'nope' }, ...good.slice(1)]),
  )
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(300)

check(
  'corrupt rows are dropped and the real sessions still load — no crash, no empty history',
  JSON.stringify(await history(page)) === JSON.stringify(before),
  `three junk rows spliced into storage; all ${before.length} real sessions survived intact`,
)

await context.close()

// ---------------------------------------------------------------------------
// Part 6 — the same claim, against REAL wall-clock time.
//
// Everything above ran on a faked clock. That is the only sane way to stage a
// three-hour sleep, but it is also, in principle, exactly the sort of thing that
// could flatter an implementation: we control Date.now(), so of course the sums
// come out. This part controls nothing. It is a real 60-second focus block, in
// real time, and across its deadline the page's heartbeat is taken away
// entirely — zero interval callbacks, which is worse than any real background
// tab (a throttled one still gets roughly one a minute).
//
// If the app counted ticks, it would come back from that having lost the whole
// minute and would record nothing at all. Recording an exact 60-second session
// is only possible by deriving from the stored deadline.
// ---------------------------------------------------------------------------
console.log('\n▸ REAL TIME: a 60s focus block that ends with the tab fully frozen\n')

const real = await launch({ fakeClock: false, instrument: true })
await real.page.evaluate(() => localStorage.clear())
await real.page.reload({ waitUntil: 'networkidle' })

// One minute is the shortest block the app allows, and it is a real minute.
await real.page.getByTestId('cfg-focus').fill('1')
await real.page.getByRole('button', { name: 'Start focus' }).click()
const startedWall = Date.now()

const beforeFreeze = await real.page.getByTestId('remaining').textContent()
await real.page.evaluate(() => window.__suspendTicks())

// Prove the fault actually landed: with no ticks, the clock face must go stale.
// If it kept repainting, the freeze did nothing and the rest of this is vacuous.
await real.page.waitForTimeout(4_000)
check(
  'the freeze is real: with every tick suppressed, the clock face stops repainting',
  beforeFreeze === (await real.page.getByTestId('remaining').textContent()),
  `readout held at ${beforeFreeze} across 4s of real time with zero interval callbacks`,
)

console.log('\n  … holding for 65 real seconds, not ticking, straight through the deadline\n')
await real.page.waitForTimeout(61_000)

// The tab is looked at again.
await real.page.evaluate(() => window.__resumeTicks())
await real.page.waitForTimeout(500)
const noticedWall = Date.now()

const realSession = await real.page.evaluate(
  () => JSON.parse(localStorage.getItem('clock.sessions.v1'))[0],
)

check(
  'the block that ended while the tab was frozen is in history, exact to the millisecond',
  realSession &&
    realSession.outcome === 'completed' &&
    realSession.focusedMs === 60_000 &&
    realSession.endedAt - realSession.startedAt === 60_000,
  `recorded ${realSession?.focusedMs}ms of focus across a real 60s block whose deadline passed ` +
    `with the page receiving ZERO ticks. A tick-counter would have recorded nothing at all.`,
)
check(
  'and it is dated at its true deadline, not at the moment we came back',
  realSession && realSession.endedAt < noticedWall - 3_000 && realSession.endedAt >= startedWall,
  `ended at ${new Date(realSession.endedAt).toISOString()}; we did not look until ` +
    `${((noticedWall - realSession.endedAt) / 1000).toFixed(1)}s later. The session is dated when ` +
    `the work finished, not when the tab woke up.`,
)

await real.page.screenshot({ path: 'evidence/13-realtime-frozen-tab.png', fullPage: true })

check('no console or page errors anywhere', errors.length === 0, errors.join('; ') || 'none')

await real.context.close()
rmSync(profile, { recursive: true, force: true })

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length ? 1 : 0)
