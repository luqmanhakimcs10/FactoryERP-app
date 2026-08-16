/**
 * The Delivery Person's three tabs, in a real browser, against Alpha.
 *
 *   node scripts/serve-dist.mjs &        # after: npm run build:web
 *   node scripts/dp-tab-shots.mjs
 *
 * WHY A BROWSER AND NOT JUST THE RPC
 * The bug this script exists to close was invisible to every RPC suite: the
 * three tabs and all four transitions were correct in SQL and correct in the
 * screen's source, and the queue returned exactly the right rows for each tab.
 * What was shipped was a MONTH-OLD BUNDLE, so the tested app was still the old
 * single flat list. A green RPC suite and a stale dashboard are entirely
 * compatible — the same trap `banner-shots.mjs` was written for. So this asserts
 * the pixels.
 *
 * It also drives the banner, which was the second bug: the delivery banners are
 * rendered BY this screen and point back AT it, so `navigate('RoleHome', {tab})`
 * hit an already-mounted route and only the params changed. Nothing but a real
 * click can prove that is fixed, because the navigation call was always firing.
 *
 * Expectations are READ FROM the live queue rather than hardcoded, so the checks
 * keep working as the factory's data moves.
 *
 * Screenshots land in ./.dp-shots.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:4173';
const SHOTS = process.env.SHOTS ?? '.dp-shots';
mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL, KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };
const chk = (c, m) => (c ? ok(m) : no(m));

/** What the database says the delivery person's tabs and banners hold. */
async function truth() {
  const auth = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'delivery@alpha.test', password: 'Password123!' }),
  })).json();
  const call = async (fn) => (await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })).json();
  const rows = await call('dp_orders_queue');
  const byTab = { collection: [], delivery: [], pickup: [] };
  for (const r of rows) byTab[r.tab]?.push(r);
  const banners = (await call('my_queue_summary')).filter((r) => r.own_task && Number(r.count) > 0);
  return { byTab, banners };
}

const { byTab, banners } = await truth();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

async function waitForText(test, timeout, what) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (test(body)) return body;
    await page.waitForTimeout(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const text = () => page.evaluate(() => document.body.innerText);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
await page.context().clearCookies();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('input').first().waitFor({ timeout: 30000 });
await page.locator('input').nth(0).fill('delivery@alpha.test');
await page.locator('input').nth(1).fill('Password123!');
await page.getByText(/^sign in$/i).first().click();
await waitForText((t) => /collection/i.test(t), 45000, "the delivery person's dashboard");
await page.waitForTimeout(2500);

console.log('\n========= DELIVERY PERSON — THREE TABS, Alpha =========\n');

// --- 1. the structure itself ----------------------------------------------
console.log('--- the dashboard has three tabs, not one flat list ---');
await page.screenshot({ path: `${SHOTS}/00-dashboard.png`, fullPage: true });
const home = await text();
for (const t of ['Collection', 'Delivery', 'Pickup']) chk(home.includes(t), `"${t}" tab is on screen`);
// The old shape's tell: one list headed "Orders" with no tabs at all.
chk(!/^orders$/im.test(home), 'no flat "Orders" list heading (the pre-0084 shape)');

// --- 2. each tab, with its real rows --------------------------------------
for (const [key, label] of [['collection', 'Collection'], ['delivery', 'Delivery'], ['pickup', 'Pickup']]) {
  console.log(`\n--- ${label} tab ---`);
  await page.getByText(new RegExp(`^${label}( \\(\\d+\\))?$`)).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/0${'cdp'.indexOf(key[0]) + 1}-${key}.png`, fullPage: true });
  const body = await text();

  const expect = byTab[key];
  chk(body.includes(`${label} (${expect.length})`) || expect.length === 0,
    `tab header shows the count the queue returns (${expect.length})`);
  for (const r of expect) chk(body.includes(r.repeat_code), `${label}: ${r.repeat_code} is listed`);
  // No row from another tab has leaked in.
  for (const other of Object.keys(byTab).filter((k) => k !== key))
    for (const r of byTab[other])
      chk(!body.includes(r.repeat_code), `${label}: ${r.repeat_code} (${other}) is NOT here`);

  // Open the first row and check the action it offers is the one this tab owns.
  if (expect.length) {
    await page.getByText(expect[0].repeat_code).first().click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOTS}/0${'cdp'.indexOf(key[0]) + 1}-${key}-open.png`, fullPage: true });
    const open = await text();

    // Every leg of this loop is a custody change, so every one demands a photo.
    chk(/photo/i.test(open), `${label}: the open row asks for a photo`);

    if (key === 'collection') {
      chk(/collect from floor manager/i.test(open), 'Collection: offers "Collect from Floor Manager"');
      // The whole point of Fix 5 — the handover button must NOT be reachable here.
      chk(!/handover to/i.test(open), 'Collection: no "Handover to…" button at this stage');
    }
    if (key === 'delivery') {
      chk(/handover to/i.test(open), 'Delivery: offers "Handover to <partner>"');
      if (expect[0].partner_name) {
        chk(open.includes(expect[0].partner_name),
          `Delivery: names the already-chosen partner (${expect[0].partner_name})`);
        chk(!/finishing partner\s*\*/i.test(open) && !/pick one to send it out/i.test(open),
          'Delivery: no partner re-selection asked for');
      }
    }
    if (key === 'pickup') {
      chk(/collect from|return to floor manager/i.test(open),
        'Pickup: offers collect-back / return to the Floor Manager');
    }
    await page.getByText(expect[0].repeat_code).first().click();  // close it again
    await page.waitForTimeout(400);
  }
}

// --- 3. the banner is not a dead click ------------------------------------
// This is the regression that matters: the banner lives on this screen and
// points back at it, so before the fix the tap changed route params and nothing
// else. Proving it means clicking it from a DIFFERENT tab and watching the tab
// actually move.
console.log('\n--- the dashboard banner opens the right tab ---');
const BANNER_TAB = { dp_collect: 'Collection', dp_send: 'Delivery', dp_pickup: 'Pickup', dp_handback: 'Pickup' };
for (const b of banners.filter((x) => BANNER_TAB[x.queue_key])) {
  const want = BANNER_TAB[b.queue_key];
  // Park on a tab that is NOT the destination, so a no-op is visible as one.
  const park = want === 'Collection' ? 'Pickup' : 'Collection';
  await page.getByText(new RegExp(`^${park}( \\(\\d+\\))?$`)).first().click();
  await page.waitForTimeout(800);

  const banner = page.getByText(b.banner_title).first();
  if (!(await banner.count())) { no(`"${b.banner_title}" banner is on screen`); continue; }
  ok(`"${b.banner_title}" banner is on screen`);
  await banner.click();
  await page.waitForTimeout(1200);

  // The destination tab is the selected one, and its rows are what is listed.
  const body = await text();
  const wantRows = byTab[want.toLowerCase()];
  const landed = wantRows.every((r) => body.includes(r.repeat_code)) &&
                 byTab[park.toLowerCase()].every((r) => !body.includes(r.repeat_code) || want === park);
  chk(landed, `"${b.banner_title}" -> lands on the ${want} tab (was on ${park})`);
  await page.screenshot({ path: `${SHOTS}/10-banner-${b.queue_key}.png`, fullPage: true });
}

// Tapping the SAME banner twice must work twice — the param is consumed after
// it is applied, which is what makes the second tap live.
console.log('\n--- the same banner works a second time ---');
{
  const b = banners.find((x) => BANNER_TAB[x.queue_key]);
  if (b) {
    const want = BANNER_TAB[b.queue_key];
    const park = want === 'Collection' ? 'Pickup' : 'Collection';
    await page.getByText(new RegExp(`^${park}( \\(\\d+\\))?$`)).first().click();
    await page.waitForTimeout(800);
    await page.getByText(b.banner_title).first().click();
    await page.waitForTimeout(1200);
    const body = await text();
    chk(byTab[want.toLowerCase()].every((r) => body.includes(r.repeat_code)),
      `"${b.banner_title}" -> still lands on ${want} on a repeat tap`);
  }
}

console.log('\n--- console errors ---');
chk(errors.length === 0, errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : 'no page errors');

await browser.close();
console.log(`\n============ ${pass} passed, ${fail} failed ============`);
console.log(`screenshots: ${SHOTS}/\n`);
process.exit(fail ? 1 : 0);
