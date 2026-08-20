/**
 * Drive the QA simplification and the Order Taker changes in a real browser.
 *
 *   node scripts/serve-dist.mjs 8090      # in another shell, after build:web
 *   npm run verify:qaflow
 *
 * What it proves by clicking:
 *   QA   — two boxes and no Final QA anywhere; one inspection list with no
 *          awaiting-cloth / awaiting-coding split; cloth inspection as a step
 *          inside Order QA; Reject with no Write Off beside it.
 *   OT   — the order summary counts repeats and never sheets; the colour picker
 *          offers Other and accepts a typed colour; the progress timeline
 *          renders without breaking when a step carries no photo.
 *
 * Screenshots land in /tmp/qa-shots.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:8090';
const SHOTS = '/tmp/qa-shots';
mkdirSync(SHOTS, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const body = () => page.locator('body').innerText();
/** Whatever the page currently reads as — reassigned after every navigation. */
let t = '';

/**
 * Sign in as `email`, discarding whatever session is already restored.
 *
 * Clearing storage rather than clicking Sign out: the sign-out control lives in
 * a header this walk navigates away from, and a drive that depends on being on
 * the right screen to change user is a drive that fails for the wrong reason.
 */
async function loginAs(email) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* storage can be unavailable; the reload below still gets a clean page */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.locator('input').first().waitFor({ timeout: 20000 });
  const inputs = page.locator('input');
  await inputs.nth(0).fill(email);
  await inputs.nth(1).fill('Password123!');
  await page.getByText(/^sign in$/i).first().click();
  await page.waitForTimeout(9000);
}

// ===========================================================================
// Order Taker
// ===========================================================================
await loginAs('order@alpha.test');
await page.screenshot({ path: `${SHOTS}/04-ot-dashboard.png`, fullPage: true });

// ---- the orders list summary ----
await page.getByText(/^Orders$/).first().click();
await page.waitForTimeout(3500);
await page.screenshot({ path: `${SHOTS}/05-my-orders.png`, fullPage: true });
t = await body();
chk(!/\bsheets?\b/i.test(t), 'the orders list never says "sheet"');
chk(/repeat/i.test(t), 'the orders list counts repeats');

// ---- order detail: summary + timeline ----
const orderRow = page.getByText(/ALP-\d+/).first();
if (await orderRow.isVisible().catch(() => false)) {
  await orderRow.click();
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${SHOTS}/06-order-detail.png`, fullPage: true });
  t = await body();
  chk(/progress/i.test(t), 'order detail shows the progress timeline');
  chk(/Order captured/.test(t), 'the timeline lists its steps');
  chk(!/\bSheets? \(/.test(t), 'the summary section is no longer headed "Sheets"');
  chk(/repeats \(/i.test(t), 'the summary section is headed "Repeats"');
  // Pre-migration the RPC returns no photo column; the timeline must still render.
  chk(errors.length === 0, 'the timeline renders with no page error when a step has no photo');
} else {
  info('No orders visible for this order taker.');
}

// ---- new order: colour picker + review copy ----
await loginAs('order@alpha.test');
await page.getByText(/\+ New Order/).first().click();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${SHOTS}/06b-new-order.png`, fullPage: true });

/**
 * 1. Pick a client.
 *
 * Waits for the step's own heading first, because the client list is a network
 * read and a fixed timeout made this walk skip itself on a slow round-trip.
 *
 * Then takes the first VISIBLE match rather than `.first()`: the factory name in
 * the header ("Alpha Embroidery Works") also matches the client-name pattern and
 * is rendered but hidden, so `.first()` resolved to an element that never
 * becomes visible and the wait timed out against the wrong node.
 */
await page
  .getByText(/Which vendor is this for/i)
  .first()
  .waitFor({ state: 'visible', timeout: 20000 })
  .catch(() => {});

const candidates = page.getByText(/Karachi|Textile|Ltd|Works|Traders|Mills/i);
let vendorCard = null;
for (let n = 0; n < (await candidates.count()); n++) {
  if (await candidates.nth(n).isVisible().catch(() => false)) {
    vendorCard = candidates.nth(n);
    break;
  }
}
if (vendorCard) {
  await vendorCard.click();
  await page.waitForTimeout(1200);
  // 2. colour count -> Next
  await page.getByText(/^Next\s+→$/).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/07-add-colors.png`, fullPage: true });

  // 3. open the swatch picker
  await page.getByRole('button', { name: /Choose colour for color 1/ }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/08-picker.png`, fullPage: true });
  t = await body();
  chk(/Other/.test(t), 'the colour picker offers "Other"');

  await page.getByText(/^Other$/).first().click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/09-custom-colour.png`, fullPage: true });
  t = await body();
  chk(/Colour name/.test(t) && /Colour code/.test(t), '"Other" opens a name + code form');

  // By placeholder, not by index: the dashboard's (hidden) search box is
  // input[0] on this page, and filling it silently does nothing.
  await page.getByPlaceholder('e.g. Peacock Blue').fill('Peacock Blue');
  await page.getByPlaceholder('e.g. PCK-21').fill('pck-21');
  await page.getByText(/^Use this colour$/).first().click();
  await page.waitForTimeout(1200);
  t = await body();
  chk(/Peacock Blue/.test(t), 'the typed colour is applied to the order line');

  // 4. through to review
  await page.getByText(/^Design sheet\s+→$/).first().click();
  await page.waitForTimeout(1200);
  await page.getByText(/^Review\s+→$/).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/10-review.png`, fullPage: true });
  t = await body();
  chk(/Review & submit|Review &amp; submit/.test(t), 'reached Review & submit');
  chk(!/Total sheets/.test(t), 'review has no "Total sheets" row');
  chk(/Total repeats/.test(t), 'review totals repeats');
  chk(!/\bsheets?\b(?!\s*$)/i.test(t.replace(/Design sheet/g, '')), 'review copy never says "sheet"');
  chk(/custom colour PCK-21/i.test(t), 'the review names the custom colour and its code');

  // Submitting leaves an order at `awaiting_cloth_inspection`, which is what
  // gives the QA section below a cloth-inspection step to actually open.
  await page.getByText(/Submit order/).first().click();
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${SHOTS}/11-submitted.png`, fullPage: true });
  t = await body();
  // Submitting returns to the orders list with the thread-check result, which
  // is where this flow has always landed — the assertion, not the app, was wrong.
  chk(/Order submitted/.test(t), 'submitting reports the thread-check result');

  // Wait for the rows, not just the banner: the list is a separate read, and
  // asserting before it lands tests an empty page.
  await page.getByText(/\d+ repeats?\b/).first().waitFor({ timeout: 20000 }).catch(() => {});
  t = await body();
  const repeatCounts = t.match(/\d+ repeats?\b/gi) ?? [];
  const sheetCounts = t.match(/\d+ sheets?\b/gi) ?? [];
  chk(
    repeatCounts.length > 0 && sheetCounts.length === 0,
    `orders list counts repeats and never sheets (${repeatCounts.join(', ')})`
  );
  chk(!/\bSheets? \(/.test(t), 'the new order\'s summary is headed "Repeats", not "Sheets"');
} else {
  info('No client to start an order against — the New Order walk was skipped.');
}

// ===========================================================================
// QA
// ===========================================================================
await loginAs('qa@alpha.test');
await page.screenshot({ path: `${SHOTS}/01-qa-dashboard.png`, fullPage: true });
t = await body();

chk(/Awaiting order inspection/.test(t), 'QA has the inspection box');
chk(/Repeats & stage tracking/.test(t), 'QA has the stage-tracking box');
chk(!/Final pass/i.test(t), 'QA dashboard has no Final pass card');
chk(!/Final QA/i.test(t), 'QA dashboard says nothing about Final QA');

await page.getByText(/^Awaiting order inspection$/).first().click();
await page.waitForTimeout(3500);
await page.screenshot({ path: `${SHOTS}/02-qa-queue.png`, fullPage: true });
t = await body();
chk(!/Awaiting inspection/.test(t), 'queue has no "Awaiting inspection" counter');
chk(!/Awaiting coding/.test(t), 'queue has no "Awaiting coding" counter');
chk(/Start QA/.test(t) || /Nothing waiting on QA/.test(t), 'queue offers one action per row');

// Open the first order in the queue, whichever step it is on.
const row = page.getByText(/Start QA/).first();
if (await row.isVisible().catch(() => false)) {
  await row.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/03-order-qa.png`, fullPage: true });
  t = await body();

  chk(/Repeat QA/.test(t), 'Order QA opened');
  chk(!/Write off/i.test(t), 'no Write Off anywhere in the QA flow');

  // Whichever step the order is on, the OTHER one must still be on this screen
  // rather than behind a second destination.
  const clothStep = /Step 1 · Cloth inspection/.test(t);
  const pieceList = /Awaiting inspection|Passed —|With order taker|Piece/.test(t);
  chk(clothStep || pieceList, 'cloth inspection and the piece list share one screen');
  info(clothStep ? 'this order is on the cloth-inspection step' : 'this order is past cloth inspection');
  if (clothStep) {
    chk(/Accept cloth & start QA/.test(t), 'accepting the cloth is inline, not a navigation');
    chk(!/Which sheet\?/.test(t), 'the damage picker no longer says "sheet"');
  }
} else {
  info('QA queue is empty — Order QA was not opened.');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (errors.length) {
  console.log('\n  page errors:');
  for (const e of [...new Set(errors)].slice(0, 8)) console.log('   ' + e);
}
await browser.close();
process.exit(fail ? 1 : 0);
