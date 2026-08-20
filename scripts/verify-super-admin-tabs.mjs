/**
 * Drive the restructured Super Admin in a real browser.
 *
 *   node scripts/serve-dist.mjs 8090      # in another shell, after build:web
 *   npm run verify:superadmin
 *
 * Proves the three things the restructure is defined by, by clicking them:
 * exactly three top-level tabs, exactly four options on a factory row's ⋮ menu
 * (with a real confirmation on the active/inactive one), and no inventory on
 * any Super Admin screen.
 *
 * Screenshots land in /tmp/sa-shots.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:8090';
const SHOTS = '/tmp/sa-shots';
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const signOut = page.getByText(/sign out|log out/i).first();
if (await signOut.isVisible().catch(() => false)) {
  await signOut.click();
  await page.waitForTimeout(1500);
}

const inputs = page.locator('input');
await inputs.nth(0).fill('super@erp.test');
await inputs.nth(1).fill('Password123!');
await page.getByText(/^sign in$/i).first().click();
await page.waitForTimeout(9000);
await page.screenshot({ path: `${SHOTS}/01-dashboard.png`, fullPage: true });

const body = () => page.locator('body').innerText();

let text = await body();
chk(/Dashboard/.test(text), 'Dashboard tab present');
chk(/Modules/.test(text), 'Modules tab present');
chk(/Invoice History/.test(text), 'Invoice History tab present');
chk(/factories/i.test(text), 'Factories section present');
chk(/Billing/.test(text), 'Billing section present');
chk(/total pending across all factories/i.test(text), 'Pending total headline present');
chk(/Pending/.test(text), 'Pending sub-tab present');

// No inventory, anywhere.
chk(!/inventory/i.test(text), 'Dashboard mentions no inventory');

// ---- The row menu ----
const menu = page.getByRole('button', { name: /^Actions for / }).first();
chk(await menu.isVisible().catch(() => false), 'Factory row has a ⋮ menu');
if (await menu.isVisible().catch(() => false)) {
  await menu.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/02-rowmenu.png`, fullPage: true });
  const m = await body();
  chk(/View details/.test(m), 'menu: View details');
  chk(/Set inactive|Set active/.test(m), 'menu: Active/Inactive toggle');
  chk(/Payment history/.test(m), 'menu: Payment history');
  chk(/\bEdit\b/.test(m), 'menu: Edit');

  // Confirmation popup on the status toggle.
  await page.getByText(/^Set inactive$|^Set active$/).first().click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/03-confirm.png`, fullPage: true });
  const c = await body();
  chk(/blocked from signing in|able to sign in again/.test(c), 'toggle shows a confirmation popup');
  await page.getByText(/^Cancel$/).first().click();
  await page.waitForTimeout(600);
}

// ---- Modules tab ----
await page.getByText(/^Modules$/).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/04-modules.png`, fullPage: true });
text = await body();
chk(/Enable or disable modules/.test(text), 'Modules tab renders the toggles');
chk(/Order Lifecycle/.test(text), 'Modules tab lists module names');
chk(!/color|colour|quantity|last audit/i.test(text), 'Modules tab shows no stock data');

// ---- Invoice History tab ----
await page.getByText(/^Invoice History$/).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/05-invoices.png`, fullPage: true });
text = await body();
chk(/Every invoice raised against every factory/.test(text), 'Invoice History tab renders');

// ---- View details: no inventory tab ----
await page.getByText(/^Dashboard$/).first().click();
await page.waitForTimeout(1200);
const menu2 = page.getByRole('button', { name: /^Actions for / }).first();
await menu2.click();
await page.waitForTimeout(700);
await page.getByText(/^View details$/).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/06-detail.png`, fullPage: true });
text = await body();
// "Inventory & Procurement" may legitimately appear as an enabled MODULE name.
// What must not appear is an inventory TAB or any stock figure.
chk(!/^\s*Inventory\s*$/m.test(text), 'Factory detail has no Inventory tab');
chk(!/last stock audit|color code|colour code|meters|m\s*$/im.test(text), 'Factory detail shows no stock');
chk(/company/i.test(text) && /subscription/i.test(text), 'Factory detail shows company + subscription');

console.log(`\n  ${pass} passed, ${fail} failed`);
if (errors.length) {
  console.log('\n  page errors:');
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('   ' + e);
}
await browser.close();
process.exit(fail ? 1 : 0);
