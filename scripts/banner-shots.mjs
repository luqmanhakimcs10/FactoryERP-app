/**
 * Every role's dashboard, in a real browser, with its banners on screen.
 *
 *   node scripts/serve-dist.mjs &     # after: npm run build:web
 *   node scripts/banner-shots.mjs
 *
 * WHY A BROWSER AND NOT JUST THE RPC
 * `verify:banners` proves the DATABASE offers the right queues. It cannot prove
 * the dashboard renders them — and that is exactly where the last bug lived: the
 * job-card queue was in `my_queue_summary` the whole time, correctly counting
 * 19, while the screen showed only one hardcoded banner. A green RPC suite and a
 * broken dashboard are entirely compatible, so this script asserts the pixels.
 *
 * Expectations are READ FROM the live summary rather than hardcoded: whatever
 * the database says this role should see, the dashboard must actually show. So
 * the check keeps working as the factory's data moves, and it fails if a banner
 * is offered but not rendered.
 *
 * Screenshots land in ./.banner-shots. Alpha factory.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:4173';
const SHOTS = process.env.SHOTS ?? '.banner-shots';
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

/** What the database says this role's banners should be. */
async function expectedBanners(email) {
  const auth = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  })).json();
  const rows = await (await fetch(`${URL_}/rest/v1/rpc/my_queue_summary`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })).json();
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.own_task && Number(r.count) > 0)
    .map((r) => r.banner_title);
}

const ROLES = [
  ['floor-manager',     'floor'],
  ['qa',                'qa'],
  ['order-taker',       'order'],
  ['store-manager',     'store'],
  ['delivery',          'delivery'],
  ['finishing-partner', 'partner'],
  ['accountant',        'accountant'],
  ['owner',             'owner'],
  ['procurement',       'procurement'],
  ['worker',            'worker'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

/** Poll the rendered text until `test` passes — the app boots via a splash and
 *  then hydrates, so fixed sleeps either flake or waste minutes across 10 roles. */
async function waitForText(test, timeout, what) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (test(body)) return body;
    await page.waitForTimeout(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Session is cleared between roles rather than clicked through a sign-out menu:
 * the menu's location differs per role, and a failed sign-out silently leaves
 * the PREVIOUS role's dashboard on screen — which would make this script assert
 * the wrong person's banners and still go green.
 *
 * The login screen's placeholders are "you@factory.test" and a row of bullets,
 * so matching on /email/i finds nothing; positional inputs are what survives.
 */
async function login(who) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
  await page.context().clearCookies();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  await page.locator('input').first().waitFor({ timeout: 30000 });
  const inputs = page.locator('input');
  await inputs.nth(0).fill(`${who}@alpha.test`);
  await inputs.nth(1).fill('Password123!');
  await page.getByText(/^sign in$/i).first().click();

  // Landed when the splash is gone and something real is rendered.
  await waitForText((t) => t.trim().length > 40 && !/^factory erp\s*$/i.test(t.trim()),
    45000, `${who}'s dashboard`);
  await page.waitForTimeout(2500);  // let the banner query settle
}

console.log('\n========= BANNERS ON SCREEN — Alpha =========\n');

for (const [name, who] of ROLES) {
  const expected = await expectedBanners(`${who}@alpha.test`);
  await login(who);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

  const body = await page.evaluate(() => document.body.innerText);
  console.log(`--- ${name} (${expected.length} banner(s) expected) ---`);

  if (expected.length === 0) {
    // Nothing pending must mean no banner block at all, not an empty card.
    chk(!/need a job card|ready to accept|waiting on you/i.test(body),
      `${name}: nothing pending -> dashboard shows no banners`);
  }
  for (const title of expected) {
    chk(body.includes(title), `${name}: "${title}" is on screen`);
  }
}

// ---------------------------------------------------------------------------
// The banner is only half the promise. The other half is that it lands on the
// real working screen — banner -> the filtered list -> the Job Card Builder.
// ---------------------------------------------------------------------------
console.log('\n--- floor manager: banner -> list -> job card builder ---');
{
  await login('floor');
  const expected = await expectedBanners('floor@alpha.test');
  const jobCard = expected.find((t) => /job card/i.test(t));

  await page.getByText(jobCard).first().click();
  const list = await waitForText((t) => /need a job card/i.test(t), 20000, 'the filtered list');
  await page.screenshot({ path: `${SHOTS}/floor-manager-2-list.png`, fullPage: true });

  // The list must hold the same number the banner claimed.
  const claimed = Number(jobCard.match(/^(\d+)/)?.[1] ?? 0);
  const codes = [...list.matchAll(/ALP-\d{5}/g)].map((m) => m[0]);
  chk(new Set(codes).size === claimed,
    `list holds ${new Set(codes).size} orders, banner said ${claimed}`);

  await page.getByText(codes[0]).first().click();
  // The header ("Job card b…") renders before the screen's data does, so waiting
  // on the title would pass against a still-spinning screen. Wait for content.
  const builder = await waitForText((t) => /stage|sequence/i.test(t), 30000,
    "the job card builder's content");
  await page.screenshot({ path: `${SHOTS}/floor-manager-3-builder.png`, fullPage: true });
  chk(/stage|sequence/i.test(builder), `tapping ${codes[0]} opens the Job Card Builder`);
}

console.log('\n--- console errors ---');
chk(errors.length === 0, errors.length ? `page errors: ${errors.slice(0, 3).join(' | ')}` : 'no page errors');

await browser.close();
console.log(`\n============ ${pass} passed, ${fail} failed ============`);
console.log(`screenshots: ${SHOTS}/\n`);
process.exit(fail ? 1 : 0);
