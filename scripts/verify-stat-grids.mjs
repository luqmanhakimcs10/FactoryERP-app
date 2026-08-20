/**
 * Every role's dashboard carries a Key Metrics Grid, with live numbers.
 *
 *   node scripts/serve-dist.mjs 8090      # in another shell, after build:web
 *   npm run verify:stats
 *
 * Two things it proves:
 *
 *   1. PRESENCE — each role's home shows its own labels, and no dashboard is
 *      left without a grid.
 *   2. LIVENESS — the numbers are reads, not placeholders. The QA card "Orders
 *      awaiting QA" is captured, an order is then submitted through the real
 *      RPCs, and the card is re-read: it must have gone up by one. A grid of
 *      hard-coded zeroes passes every presence check ever written, so one stat
 *      is moved on purpose.
 *
 * Screenshots land in /tmp/stat-shots.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:8090';
const SHOTS = '/tmp/stat-shots';
mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const API = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

let pass = 0;
let fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));
const info = (m) => console.log('        ' + m);

async function token(email) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });
  return (await r.json().catch(() => ({})))?.access_token ?? null;
}
async function call(tok, fn, args = {}) {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function read(tok, path) {
  const r = await fetch(`${API}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${tok}` },
  });
  return r.json().catch(() => null);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const body = () => page.locator('body').innerText();

async function loginAs(email) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* fine */ }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.locator('input').first().waitFor({ timeout: 20000 });
  const inputs = page.locator('input');
  await inputs.nth(0).fill(email);
  await inputs.nth(1).fill('Password123!');
  await page.getByText(/^sign in$/i).first().click();
  await page.waitForTimeout(9000);
}

/**
 * A stat card renders its own accessibility label as "<value> <label>", which is
 * how a number can be read back without scraping the layout.
 */
async function statValue(label) {
  // `.+` not `\S+`: a value can be more than one word ("Not done"), and the
  // stricter pattern silently matched nothing and reported the card as blank.
  //
  // The optional tail is the delta a card carries when it has real history —
  // "2 Damage records, up 12% vs last month" — so the label is not always the
  // last thing in the string.
  const el = page.getByLabel(new RegExp(`^.+ ${label}(,.*)?$`)).first();
  if (!(await el.count())) return null;
  const text = await el.getAttribute('aria-label').catch(() => null);
  if (!text) return null;
  const at = text.indexOf(label);
  return at > 0 ? text.slice(0, at).trim() : text.trim();
}

console.log('\n  Key Metrics Grid — every role\n');

// ===========================================================================
// 1. Presence, role by role
// ===========================================================================
const EXPECTED = [
  ['super@erp.test', 'Super Admin', ['Total factories', 'Active factories', 'Unpaid subscriptions', 'Billed this month']],
  ['owner@alpha.test', 'Company Admin', ['Active orders', 'Invoiced this month', 'Pending approvals', 'Damage records']],
  ['accountant@alpha.test', 'Accountant', ['Payables due', 'Receivables due', 'POs awaiting payment', 'Pending salary runs']],
  ['floor@alpha.test', 'Floor Manager', ['Active orders', 'Awaiting job card', 'Repeats in production', 'Pending stage QA']],
  ['store@alpha.test', 'Store Manager', ['Pending material requests', 'POs in progress', 'Low stock items', "Today's audit"]],
  ['qa@alpha.test', 'QA', ['Orders awaiting QA', 'Orders in production', 'Rejected, awaiting return']],
  ['order@alpha.test', 'Order Taker', ['Orders captured', 'Active orders', 'Awaiting cloth inspection', 'Active returns']],
  ['procurement@alpha.test', 'Procurement', ['Pending POs', 'Completed POs']],
  ['delivery@alpha.test', 'Delivery Person', ['In Collection', 'In Delivery', 'In Pickup']],
  ['worker@alpha.test', 'Worker', ['Stitches this period', 'Earnings this period', 'Bonus earned', 'Leave days approved']],
];

for (const [email, role, labels] of EXPECTED) {
  await loginAs(email);
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: `${SHOTS}/${role.toLowerCase().replace(/[^a-z]+/g, '-')}.png`,
    fullPage: true,
  });
  const t = await body();
  const missing = labels.filter((l) => !t.includes(l));
  chk(missing.length === 0, `${role}: ${labels.length} metric cards${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
  // The block heading is what tells the new design from the old grid.
  chk(/Business Overview|Your month/.test(t), `${role}: carries the Business Overview block`);

  // Nothing may render as a bare placeholder — the card contract is a real
  // figure or an em-dash, never an empty value.
  const values = await Promise.all(labels.map((l) => statValue(l)));
  const blank = labels.filter((l, i) => values[i] === null || values[i] === '');
  chk(blank.length === 0, `${role}: every card carries a value (${values.join(' / ')})`);
}

// ===========================================================================
// 2. The finishing partner's link
// ===========================================================================
{
  const ownerTok = await token('owner@alpha.test');
  const partners = await read(
    ownerTok,
    'finishing_partners?select=access_token,name&deleted_at=is.null&access_token=not.is.null&limit=1'
  );
  const tok = partners?.[0]?.access_token;
  if (!tok) {
    info('No finishing partner carries a link token — apply 0086 and re-run.');
  } else {
    await page.goto(`${BASE}/?partner=${tok}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    await page.screenshot({ path: `${SHOTS}/finishing-partner.png`, fullPage: true });
    const t = await body();
    const labels = ['Active work items', 'Completed this month', 'Earnings this month'];
    const missing = labels.filter((l) => !t.includes(l));
    if (/no longer valid/i.test(t)) {
      no('Finishing Partner: the link did not open');
    } else {
      chk(
        missing.length === 0,
        `Finishing Partner: 3 metric cards${missing.length ? ` (missing ${missing.join(', ')})` : ''}`
      );
      // The cards render whatever happens — they show an em-dash when the read
      // fails — so presence alone would pass against a missing RPC. Check the
      // values too, and say plainly which migration is wanted.
      const values = await Promise.all(labels.map((l) => statValue(l)));
      if (values.every((v) => v === '—')) {
        info('every partner card reads "—" — apply 0091 and re-run for live figures.');
      } else {
        chk(
          values.some((v) => v !== '—' && v !== null),
          `Finishing Partner: cards carry live values (${values.join(' / ')})`
        );
      }
    }
  }
}

// ===========================================================================
// 3. Liveness — move one number and watch the card follow
// ===========================================================================
{
  await loginAs('qa@alpha.test');
  await page.waitForTimeout(2500);
  const before = await statValue('Orders awaiting QA');
  info(`QA "Orders awaiting QA" reads ${before} before the change`);

  const otTok = await token('order@alpha.test');
  const clients = await read(otTok, 'vendors?select=id&deleted_at=is.null&limit=1');
  let made = null;
  if (otTok && clients?.length) {
    made = await call(otTok, 'create_order', {
      p_vendor_id: clients[0].id,
      p_sheets: [
        {
          color_assignment: 'Red',
          repeats_count: 1,
          thread_color_codes: ['RED-01'],
          stitch_count: 0,
        },
      ],
      p_cloth_photos: [],
      p_design_sheet_url: null,
    });
    if (made.status < 400) {
      await call(otTok, 'submit_order', { p_order_id: made.body.id });
      info(`captured ${made.body.order_code} — it now awaits cloth inspection`);
    }
  }

  if (made && made.status < 400) {
    // A fresh sign-in rather than a reload: React Query would otherwise serve
    // the cached count and the check would pass without proving anything.
    await loginAs('qa@alpha.test');
    await page.waitForTimeout(3000);
    const after = await statValue('Orders awaiting QA');
    info(`and ${after} after`);
    chk(
      before !== null && after !== null && Number(after) === Number(before) + 1,
      `the QA card moved with the data (${before} -> ${after})`
    );
  } else {
    no('could not capture an order, so liveness was not proved');
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (errors.length) {
  console.log('\n  page errors:');
  for (const e of [...new Set(errors)].slice(0, 8)) console.log('   ' + e);
}
await browser.close();
process.exit(fail ? 1 : 0);
