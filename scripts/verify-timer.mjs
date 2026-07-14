/**
 * Drives the production bundle in a real Chromium and asserts the countdown is
 * wall-clock accurate across a backgrounded tab.
 *
 * A tick-counting timer passes the "counts down" check and fails the
 * background check — that is the whole point of this script.
 *
 * Usage: node scripts/verify-timer.mjs [baseUrl]
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:4173/productivity-clock/'
const BACKGROUND_MS = 65_000
const TOLERANCE_MS = 1_500

const parse = (mmss) => {
  const [m, s] = mmss.split(':').map(Number)
  return (m * 60 + s) * 1000
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await page.goto(BASE, { waitUntil: 'networkidle' })
const readout = page.getByTestId('remaining')

// 1. Idle render
const idle = await readout.textContent()
check('clock face renders at rest', idle === '25:00', `displayed ${idle}, expected 25:00`)
await page.screenshot({ path: 'evidence/01-idle.png' })

// 2. Countdown actually runs
await page.getByRole('button', { name: 'Start focus' }).click()
const startedAt = Date.now()
await page.waitForTimeout(3000)
const after3s = parse(await readout.textContent())
const expected3s = 25 * 60_000 - (Date.now() - startedAt)
check(
  'countdown decrements while foregrounded',
  Math.abs(after3s - expected3s) <= TOLERANCE_MS,
  `displayed ${await readout.textContent()} (${after3s}ms), expected ~${Math.round(expected3s)}ms`,
)
await page.screenshot({ path: 'evidence/02-running.png' })

// 3. THE test: background the tab for >60s. Chromium throttles timers in hidden
//    pages to ~1/min, so a setInterval-counting timer visibly loses time here.
console.log(`\n… backgrounding tab for ${BACKGROUND_MS / 1000}s (real elapsed time)\n`)
const distraction = await context.newPage()
await distraction.goto('about:blank')
await distraction.bringToFront()
await page.waitForTimeout(BACKGROUND_MS)
await page.bringToFront()
await distraction.close()

const afterBg = parse(await readout.textContent())
const expectedBg = 25 * 60_000 - (Date.now() - startedAt)
const drift = Math.abs(afterBg - expectedBg)
check(
  'survives a backgrounded tab with no drift',
  drift <= TOLERANCE_MS,
  `displayed ${await readout.textContent()} (${afterBg}ms), expected ~${Math.round(expectedBg)}ms, drift ${drift}ms`,
)
await page.screenshot({ path: 'evidence/03-after-background.png' })

// 4. Reset returns to rest
await page.getByRole('button', { name: 'Reset' }).click()
const reset = await readout.textContent()
check('reset returns to 25:00', reset === '25:00', `displayed ${reset}`)

check('no console or page errors', errors.length === 0, errors.length ? errors.join('; ') : 'none')

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
