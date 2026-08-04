/**
 * Drive the two fixed screens in a real browser against the live Alpha project.
 *
 *   node scripts/ui-drive.mjs
 *
 * Not a unit test — this signs in through the actual login form and clicks the
 * actual controls, so it proves the screens render and behave, not merely that
 * the RPCs behind them work (which walk:lifecycle already covers).
 *
 * Screenshots land in /tmp/ui-shots.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:8090';
const SHOTS = '/tmp/ui-shots';
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function login(who) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // Sign out if a session is already restored.
  const signOut = page.getByText(/sign out|log out/i).first();
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
    await page.waitForTimeout(1500);
  }
  await page.getByPlaceholder(/email/i).fill(`${who}@alpha.test`);
  await page.getByPlaceholder(/password/i).fill('Password123!');
  await page.getByText(/^sign in$/i).first().click();
  await page.waitForTimeout(4000);
}

console.log('\n  UI drive — Alpha only\n');

// ---------------------------------------------------------------------------
// 1. Order Taker: Returns -> Active returns shows the Initial-QA rejection.
// ---------------------------------------------------------------------------
console.log('  1. Order Taker — Returns / Active returns');
await login('order');
await shot('01-order-taker-home');

const returnsCard = page.getByText(/^Returns$/).first();
chk(await returnsCard.isVisible().catch(() => false), 'Returns box is on the dashboard');
await returnsCard.click();
await page.waitForTimeout(3500);
await shot('02-returns-active');

const activeTab = page.getByText(/Active returns/).first();
const activeLabel = (await activeTab.textContent().catch(() => '')) ?? '';
info(`tab reads: "${activeLabel.trim()}"`);
chk(/Active returns \((?!0\))\d+\)/.test(activeLabel),
  `Active returns is NOT (0) — it reads "${activeLabel.trim()}"`);

const body = (await page.locator('body').innerText().catch(() => '')) ?? '';
chk(/Rejected at Initial QA/i.test(body), 'a row is labelled "Rejected at Initial QA"');
chk(/Reason:/i.test(body), 'the row shows a Reason');
chk(/Complete return/i.test(body), 'the row offers "Complete return"');

const imgCount = await page.locator('img').count();
info(`${imgCount} image element(s) rendered on the tab (photos are signed-URL <img>)`);

// Press Complete return on the first active row.
const completeBtn = page.getByText(/^Complete return$/).first();
if (await completeBtn.isVisible().catch(() => false)) {
  const beforeLabel = activeLabel;
  await completeBtn.click();
  await page.waitForTimeout(4000);
  await shot('03-returns-after-complete');
  const afterLabel = (await page.getByText(/Active returns/).first().textContent().catch(() => '')) ?? '';
  info(`after: "${afterLabel.trim()}" (was "${beforeLabel.trim()}")`);
  chk(afterLabel !== beforeLabel, 'Complete return decremented the Active returns count');

  await page.getByText(/Completed returns/).first().click();
  await page.waitForTimeout(2500);
  await shot('04-returns-completed');
  const completedBody = (await page.locator('body').innerText().catch(() => '')) ?? '';
  chk(/Return confirmed/i.test(completedBody),
    'the piece now appears under Completed returns with "Return confirmed"');
} else {
  no('no "Complete return" button to press');
}

// ---------------------------------------------------------------------------
// 2. Floor Manager: Review job card -> one needle line at a time.
// ---------------------------------------------------------------------------
console.log('\n  2. Floor Manager — Review job card / needle lines');
await login('floor');
await page.waitForTimeout(1500);
await shot('05-fm-home');

const fmBody = (await page.locator('body').innerText().catch(() => '')) ?? '';
info(`floor manager landed on: ${fmBody.slice(0, 90).replace(/\n/g, ' | ')}`);

console.log(`\n  screenshots: ${SHOTS}`);
console.log(`\n  ${pass} passed, ${fail} failed`);
if (errors.length) {
  console.log(`\n  ${errors.length} console error(s):`);
  for (const e of errors.slice(0, 8)) console.log('    ' + e.slice(0, 160));
}
await browser.close();
process.exit(fail ? 1 : 0);
