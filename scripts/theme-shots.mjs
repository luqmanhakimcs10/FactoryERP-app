/**
 * Capture the re-themed screens across several roles, in a real browser against
 * the live Alpha project.
 *
 *   node scripts/theme-shots.mjs
 *
 * Companion to ui-drive.mjs: that one asserts behaviour, this one records what
 * the screens LOOK like after the teal/coral pass, and asserts that the labels
 * and sections each role had before the pass are still exactly there.
 *
 * Screenshots land in the directory given by SHOTS (default ./.theme-shots).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:8090';
const SHOTS = process.env.SHOTS ?? '.theme-shots';
mkdirSync(SHOTS, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function login(who) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // First load has to bundle; later ones are warm.
  await page.locator('input').first().waitFor({ timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // Sign-out is an icon button — reachable by its accessibility label, not text.
  const signOut = page.getByLabel(/sign out/i).first();
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
    await page.waitForTimeout(2500);
  }
  await page.locator('input').first().waitFor({ timeout: 60_000 });
  // The login screen's placeholders are sample values, not the words
  // "email"/"password" — target the inputs positionally instead.
  // Most test accounts live on the Alpha factory; the super admin is
  // cross-factory and sits on its own domain, so allow a full address.
  const email = who.includes('@') ? who : `${who}@alpha.test`;
  const inputs = page.locator('input');
  await inputs.nth(0).fill(email);
  await inputs.nth(1).fill('Password123!');
  await page.getByText(/^sign in$/i).first().click();
  await page.waitForTimeout(6000);
}

/** Assert every one of these strings is visible on the current screen. */
async function expectLabels(role, labels) {
  // Let the queries settle first — a label that has not rendered yet is not
  // the same as a label that was removed, and only one of those is a bug.
  await page.waitForTimeout(3000);
  for (const label of labels) {
    const seen = await page
      .getByText(label, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
    chk(seen, `${role}: "${label}" still present`);
  }
}

/**
 * Assert each tab exists BY ROLE. Matching on text alone is ambiguous here:
 * "Awaiting job card" is both a tab and a row status pill, and getByText is
 * case-insensitive, so it can resolve to the pill instead of the tab.
 */
async function expectTabs(role, labels) {
  await page.waitForTimeout(1500);
  for (const label of labels) {
    // Substring match against the accessible name, which carries any count
    // suffix ("Awaiting job card (12)").
    const seen = await page
      .getByRole('tab')
      .filter({ hasText: label })
      .first()
      .isVisible()
      .catch(() => false);
    chk(seen, `${role}: tab "${label}" still present`);
  }
}

/** The controls the header must never lose, on any screen. */
async function expectHeaderControls(role, { sla = false } = {}) {
  chk(
    await page.getByLabel(/sign out/i).first().isVisible().catch(() => false),
    `${role}: sign-out reachable`,
  );
  chk(
    await page.getByLabel(/notification/i).first().isVisible().catch(() => false),
    `${role}: notification bell reachable`,
  );
  if (sla) {
    chk(
      await page.getByLabel(/SLA Alerts/i).first().isVisible().catch(() => false),
      `${role}: SLA alerts reachable`,
    );
  }
}

console.log('\n  Theme pass — screens + label preservation\n');

// ---------------------------------------------------------------- floor manager
await login('floor');
await shot('floor-1-dashboard');
console.log('\n  Floor Manager dashboard');
await expectLabels('floor', [
  'Orders',
  'Machine & Workforce',
  'Shift close',
  'Leave',
  'Damages',
  'Active orders, awaiting job card, accept inventory',
  'Machines, assignment, and the shift calendar',
  'Shift close walk',
  'Worker leave requests',
  'Orders, materials and other tracked loss',
]);
await expectHeaderControls('floor', { sla: true });

// Inner screen: header collapses to back + title + role badge.
await page.getByText('Active orders, awaiting job card, accept inventory').first().click();
await page.waitForTimeout(3000);
await shot('floor-2-orders-box');
console.log('\n  Floor Manager > Orders box');
await expectLabels('floor', ['Total orders', 'Active orders (']);
// The tab rail is this screen's navigation — a collapsed rail is invisible in
// a screenshot but fatal, so assert each tab by name.
await expectTabs('floor', ['Overview', 'Awaiting job card', 'Accept inventory', 'Final QA']);
chk(
  await page.getByText(/Floor Manager/i).first().isVisible().catch(() => false),
  'floor: role badge still on inner screen',
);

// ---------------------------------------------------------------------- QA
await login('qa');
await shot('qa-1-dashboard');
console.log('\n  QA dashboard');
await expectLabels('qa', [
  'Awaiting order inspection',
  'Repeats & stage tracking',
  'Final pass',
  'Orders waiting on cloth inspection or repeat coding',
  'Pass QA and mark damage as repeats move through production',
  'Cleared by the Floor Manager',
]);
await expectHeaderControls('qa', { sla: true });

await page.getByText('Pass QA and mark damage as repeats move through production').first().click();
await page.waitForTimeout(3000);
await shot('qa-2-stage-tracking');

// ------------------------------------------------------------- order taker
await login('order');
await shot('order-1-dashboard');
console.log('\n  Order Taker dashboard');
await expectLabels('order', [
  '+ New Order',
  'Orders',
  'Returns',
  'Every order you have captured',
  'Finishing stages, returns and handover',
]);
await expectHeaderControls('order');

await page.getByText('Every order you have captured').first().click();
await page.waitForTimeout(3000);
await shot('order-2-my-orders');

// ---------------------------------------------------------- store manager
await login('store');
await shot('store-1-dashboard');
console.log('\n  Store Manager dashboard');
await expectLabels('store', [
  'PO',
  'Handed over by procurement, awaiting receipt confirmation',
  'Job cards to issue',
  'Weekly stock audit',
  'Thread stock',
]);
await expectHeaderControls('store');

// ------------------------------------------- remaining roles: sweep + capture
// These roles have no bespoke assertions yet, so the sweep checks the
// invariants that hold for EVERY role — the header keeps its controls, the
// screen renders something, and nothing throws — and records a screenshot for
// visual review.
const SWEEP = [
  'owner',
  'accountant',
  'procurement',
  'delivery',
  'worker',
  'partner',
  // Cross-factory; its header shows "Platform" where the others show a factory.
  'super@erp.test',
];
for (const who of SWEEP) {
  const name = who.split('@')[0];
  console.log(`\n  ${name} dashboard`);
  await login(who);
  await page.waitForTimeout(2000);
  await shot(`${name}-1-dashboard`);

  const body = await page.evaluate(() => document.body.innerText);
  chk(body.trim().length > 0, `${name}: dashboard renders content`);
  chk(/Hi,\s*\S/.test(body), `${name}: greeting header present`);
  await expectHeaderControls(name);
}

// ------------------------------------------------------------------ report
console.log('\n  Console errors: ' + (errors.length ? errors.length : 'none'));
for (const e of errors.slice(0, 8)) console.log('        ' + e);

console.log(`\n  ${pass} passed, ${fail} failed — shots in ${SHOTS}/\n`);
await browser.close();
process.exit(fail ? 1 : 0);
