/**
 * Drive the Company Admin's changed master cards and employee role picker.
 *
 *   node scripts/serve-dist.mjs 8090      # in another shell, after build:web
 *   npm run verify:masters
 *
 * Proves each field change by opening the actual card: no Price and a working
 * calendar on Client, inventory types on Supplier, a number-only Machine card,
 * a Finishing Partner card with a link panel instead of a login picker, and the
 * merged/split/renamed employee roles.
 *
 * Screenshots land in /tmp/ca-shots.
 */
const BASE = process.env.UI_BASE ?? 'http://localhost:8090';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const SHOTS = '/tmp/ca-shots';
mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const body = () => page.locator('body').innerText();

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const inputs = page.locator('input');
await inputs.nth(0).fill('owner@alpha.test');
await inputs.nth(1).fill('Password123!');
await page.getByText(/^sign in$/i).first().click();
await page.waitForTimeout(9000);
await page.screenshot({ path: `${SHOTS}/00-home.png`, fullPage: true });

async function openMaster(cardLabel) {
  await page.getByText(new RegExp(`^${cardLabel}$`)).first().click();
  await page.waitForTimeout(3000);
}
async function newRecord() {
  await page.getByRole('button', { name: /^Add / }).first().click();
  await page.waitForTimeout(2500);
}
async function back() {
  await page.goBack().catch(() => {});
  await page.waitForTimeout(2000);
}

// ---- Client card ----
await openMaster('Client');
await newRecord();
await page.screenshot({ path: `${SHOTS}/01-client.png`, fullPage: true });
let t = await body();
chk(!/\bPrice\b/.test(t), 'Client card has no Price field');
chk(/Billing date/.test(t), 'Client card has a Billing date field');
// The calendar itself.
await page.getByText(/^Not set$/).first().click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${SHOTS}/02-calendar.png`, fullPage: true });
t = await body();
chk(/Mo\s*Tu\s*We/.test(t.replace(/\n/g, ' ')), 'Billing date opens a calendar');
chk(/Today/.test(t), 'Calendar offers Today');
await page.getByText(/^Today$/).first().click();
await page.waitForTimeout(700);

// ---- Supplier card ----
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await openMaster('Supplier');
await newRecord();
await page.screenshot({ path: `${SHOTS}/03-supplier.png`, fullPage: true });
t = await body();
chk(/Supplies which inventory types/.test(t), 'Supplier card has an inventory-type field');
for (const type of ['Thread', 'Tilla', 'Sequin', 'Bobbin']) {
  chk(new RegExp(type).test(t), `Supplier inventory types include ${type}`);
}

// ---- Machine card ----
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await openMaster('Machine');
await page.screenshot({ path: `${SHOTS}/04-machine-list.png`, fullPage: true });
t = await body();
chk(!/Machine type/.test(t), 'Machine list has no machine-type filter');
await newRecord();
await page.screenshot({ path: `${SHOTS}/05-machine.png`, fullPage: true });
t = await body();
chk(/Machine number/.test(t), 'Machine card asks for a machine number');
chk(!/Machine type|Sewing machine|Overlock/.test(t), 'Machine card has no type selector');

// ---- Finishing partner card ----
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await openMaster('Finishing Partner');
await newRecord();
await page.screenshot({ path: `${SHOTS}/06-partner.png`, fullPage: true });
t = await body();
chk(!/Extended partner/.test(t), 'Partner card has no "extended partner" checkbox');
chk(!/Partner login/.test(t), 'Partner card has no login picker');
chk(/Partner link/.test(t), 'Partner card shows the partner-link panel');

// ---- Employee roles ----
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await openMaster('Employees');
await page.getByText(/^\+ Add$/).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/07-roles.png`, fullPage: true });
t = await body();
chk(/Order\/Delivery Person/.test(t), 'role picker: Order/Delivery Person');
chk(/Store Manager/.test(t), 'role picker: Store Manager');
chk(/Floor Manager/.test(t), 'role picker: Floor Manager');
chk(/\bQA\b/.test(t) && !/Initial QA/.test(t), 'role picker: QA, not Initial QA');
chk(/Labour/.test(t), 'role picker: Labour still present');
chk(!/^Manager$/m.test(t), 'role picker: no bare "Manager" option');
chk(!/^Order Taker$/m.test(t), 'role picker: no separate Order Taker');
chk(!/^Delivery Person$/m.test(t), 'role picker: no separate Delivery Person');

console.log(`\n  ${pass} passed, ${fail} failed`);
if (errors.length) console.log('\n  page errors:\n   ' + [...new Set(errors)].slice(0, 8).join('\n   '));
await browser.close();
process.exit(fail ? 1 : 0);
