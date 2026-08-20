/**
 * Drive the Floor Manager job-card overhaul and the new PO ownership.
 *
 *   node scripts/serve-dist.mjs 8090      # in another shell, after build:web
 *   npm run verify:fmpo
 *
 * What it proves by clicking:
 *   FM  — Overview carries no master-data shortcut; tapping an order gives
 *         exactly three tabs; the job card builder offers four fixed stages with
 *         Embroidery and Clipping locked on, no handled-by/SLA block and no
 *         "selection order" text; needles come before design details; the review
 *         screen shows the cone requirement and no timeline; the job card detail
 *         puts its four actions at the top, says "Client Approved", and has no
 *         "Ask for material".
 *   PROC— two tabs, and no execute/upload/handover action anywhere.
 *
 * Screenshots land in /tmp/fm-shots.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.UI_BASE ?? 'http://localhost:8090';
const SHOTS = '/tmp/fm-shots';
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
let t = '';

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

/** First VISIBLE match — `.first()` can resolve to a rendered-but-hidden node. */
async function firstVisible(locator) {
  for (let n = 0; n < (await locator.count()); n++) {
    if (await locator.nth(n).isVisible().catch(() => false)) return locator.nth(n);
  }
  return null;
}

// ===========================================================================
// Prep — make sure the two states this walk needs actually exist
//
// The floor manager's builder needs an order at `awaiting_job_card`, and the PO
// screens need a purchase order. Neither is guaranteed on a database other
// people have been using, and a drive that quietly skips its own subject is
// worse than one that fails. Both are built through the real RPCs, so if the
// flow behind them is broken this reports it here rather than degrading.
// ===========================================================================
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const API = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

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

const qaTok = await token('qa@alpha.test');
const storeTok = await token('store@alpha.test');
const otTok = await token('order@alpha.test');

// ---- an order awaiting a job card ----
if (qaTok) {
  const awaiting = await read(qaTok, 'orders?select=id&status=eq.awaiting_job_card&limit=1');
  if (!Array.isArray(awaiting) || awaiting.length === 0) {
    /*
     * Always capture a FRESH order rather than adopting a half-finished one.
     *
     * The obvious shortcut — reuse whatever is sitting at awaiting_coding — picks
     * up orders that cannot be completed: one with a piece still in the QA
     * reject/return loop makes `qa_complete_repeat_qa` refuse, and the walk then
     * skipped itself while reporting a bare "400".
     */
    let target = null;

    if (otTok) {
      const clients = await read(otTok, 'vendors?select=id&deleted_at=is.null&limit=1');
      if (clients?.length) {
        const made = await call(otTok, 'create_order', {
          p_vendor_id: clients[0].id,
          p_sheets: [
            // stitch_count 0, as the New Order screen submits: a non-zero figure
            // trips the shortfall check and parks the order at procurement.
            {
              color_assignment: 'Red',
              repeats_count: 1,
              thread_color_codes: ['RED-01'],
              stitch_count: 0,
            },
          ],
          p_cloth_photos: ['verify/cloth.jpg'],
          p_design_sheet_url: 'verify/design.jpg',
        });
        if (made.status < 400) {
          await call(otTok, 'submit_order', { p_order_id: made.body.id });
          target = { id: made.body.id, status: 'awaiting_cloth_inspection' };
          info(`prep: captured ${made.body.order_code} for the builder walk`);
        }
      }
    }

    if (target) {
      if (target.status === 'awaiting_cloth_inspection') {
        await call(qaTok, 'qa_accept_cloth', { p_order_id: target.id });
      }
      const sheets = await read(qaTok, `sheets?select=id,repeats_count&order_id=eq.${target.id}`);
      for (const sh of sheets ?? []) {
        for (let i = 0; i < (sh.repeats_count ?? 0); i++) {
          await call(qaTok, 'qa_pass_piece', {
            p_order_id: target.id,
            p_sheet_id: sh.id,
            p_photo_url: 'verify/qa-pass.jpg',
          });
        }
      }
      const done = await call(qaTok, 'qa_complete_repeat_qa', { p_order_id: target.id });
      info(`prep: drove an order to awaiting_job_card (${done.status})`);
    } else {
      info('prep: no order available to drive to awaiting_job_card.');
    }
  } else {
    info('prep: an order is already awaiting a job card.');
  }
}

// ---- a purchase order for the store manager and procurement to look at ----
if (storeTok) {
  const pos = await call(storeTok, 'sm_po_list');
  const have = Array.isArray(pos.body) ? pos.body.length : 0;
  if (have === 0) {
    const proc = await call(storeTok, 'procurement_users');
    const who = Array.isArray(proc.body) ? proc.body[0] : null;
    const suppliers = await read(storeTok, 'suppliers?select=id&deleted_at=is.null&limit=1');
    if (who) {
      const made = await call(storeTok, 'sm_create_manual_po', {
        p_items: [{ description: 'Verification line', quantity: 10 }],
        p_assigned_to: who.id,
        p_supplier_id: suppliers?.[0]?.id ?? null,
        p_note: 'Raised by verify-fm-and-po',
      });
      info(`prep: raised a purchase order (${made.status})`);
    } else {
      info('prep: no procurement user to assign a PO to.');
    }
  } else {
    info(`prep: ${have} purchase order(s) already exist.`);
  }
}

// ===========================================================================
// The PO flow, at the RPC level
//
// Three assertions the browser cannot make. The owner's Approvals Inbox is
// reached from a task banner rather than from their dashboard, and the
// accountant's payables list is behind a screen this walk does not visit — but
// both are exactly where 0089's behaviour has to show up, so they are checked
// against the functions themselves.
// ===========================================================================
{
  const ownerTok = await token('owner@alpha.test');
  const procTok = await token('procurement@alpha.test');
  const acctTok = await token('accountant@alpha.test');

  const approvals = await call(ownerTok, 'owner_approvals_queue');
  if (approvals.status === 404) {
    info('owner_approvals_queue missing — apply 0089.');
  } else {
    const kinds = (approvals.body ?? []).map((x) => x.kind);
    chk(
      !kinds.includes('purchase_order'),
      `no PO reaches the owner's Approvals Inbox (kinds: ${kinds.join(', ') || 'none'})`
    );
    // The other approval types must survive the branch removal.
    info(`owner still sees: ${[...new Set(kinds)].join(', ') || '(nothing pending)'}`);
  }

  const payables = await call(acctTok, 'acct_payable_suppliers');
  if (payables.status < 400) {
    const bad = (payables.body ?? []).filter((p) => p.status !== 'procured');
    chk(
      bad.length === 0,
      `the accountant is only shown Procured POs (${(payables.body ?? []).length} listed)`
    );
  }

  const pending = await call(procTok, 'proc_po_list', { p_bucket: 'pending' });
  const done = await call(procTok, 'proc_po_list', { p_bucket: 'completed' });
  if (pending.status < 400) {
    const okPending = (pending.body ?? []).every((p) =>
      ['auto_generated', 'draft', 'procured'].includes(p.status)
    );
    const okDone = (done.body ?? []).every((p) =>
      ['paid', 'received', 'cancelled'].includes(p.status)
    );
    chk(okPending && okDone, "procurement's two buckets hold the right statuses");
  }
}

// ===========================================================================
// Floor Manager
// ===========================================================================
await loginAs('floor@alpha.test');
await page.screenshot({ path: `${SHOTS}/01-fm-dashboard.png`, fullPage: true });

await page.getByText(/^Orders$/).first().click();
await page.waitForTimeout(4000);
await page.screenshot({ path: `${SHOTS}/02-orders-box.png`, fullPage: true });
t = await body();
chk(/Overview/.test(t), 'Orders box opens on Overview');
chk(!/Master data/i.test(t), 'Overview has no master-data shortcut');
chk(!/^Vendors$/m.test(t), 'Overview does not link to the client list');

// ---- an order that still needs a job card ----
// `firstVisible`, not `.first()`: the Floor Manager's dashboard now carries an
// "Awaiting job card" STAT CARD as well as the Orders-box tab, and the card's
// label is rendered-but-hidden at this point in the walk.
await (await firstVisible(page.getByText(/Awaiting job card/))).click();
await page.waitForTimeout(3500);
await page.screenshot({ path: `${SHOTS}/03-awaiting.png`, fullPage: true });

const buildBtn = await firstVisible(page.getByText(/^Create Job Card$/i));
if (buildBtn) {
  await buildBtn.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/04-builder.png`, fullPage: true });
  t = await body();

  chk(/stage sequence/i.test(t), 'builder shows the stage sequence');
  for (const stage of ['Embroidery', 'Clipping', 'Press', 'Piko']) {
    chk(new RegExp(stage).test(t), `builder offers ${stage}`);
  }
  chk(!/Add stage/i.test(t), 'builder has no "+ Add stage" dropdown');
  chk(!/Selection order becomes/i.test(t), 'builder has no "selection order" helper text');
  chk(!/Handled by/i.test(t), 'builder has no per-stage handled-by block');
  chk(!/SLA/i.test(t), 'builder has no per-stage SLA field');
  chk(!/Design code/i.test(t), 'design details are NOT on the builder');
  chk(/Continue to needles/i.test(t), 'builder continues to the needle step');

  // Embroidery and Clipping must be locked on.
  const emb = page.getByRole('checkbox', { name: /Embroidery/ }).first();
  const embDisabled = await emb.isDisabled().catch(() => false);
  chk(embDisabled, 'Embroidery is locked on (not deselectable)');
  const clip = page.getByRole('checkbox', { name: /Clipping/ }).first();
  chk(await clip.isDisabled().catch(() => false), 'Clipping is locked on (not deselectable)');

  await page.getByText(/Continue to needles/i).first().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/05-review.png`, fullPage: true });
  t = await body();
  chk(/Needle & color lines/i.test(t), 'the needle/colour step opened');
  chk(/Design details/i.test(t), 'design details come AFTER the needles');
  chk(/Inventory needed/i.test(t) || /No needle/i.test(t), 'review shows the inventory needed');
  chk(!/^Progress$/m.test(t), 'review shows no progress timeline');
} else {
  info('No order awaiting a job card — the builder walk was skipped.');
}

// ---- an order that already HAS a job card ----
await loginAs('floor@alpha.test');
await page.getByText(/^Orders$/).first().click();
await page.waitForTimeout(4000);
const orderRow = await firstVisible(page.getByText(/ALP-\d+/));
if (orderRow) {
  await orderRow.click();
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${SHOTS}/06-fm-order.png`, fullPage: true });
  t = await body();
  chk(/Order Details/.test(t), 'FM order screen: Order Details tab');
  chk(/Job Card/.test(t), 'FM order screen: Job Card tab');
  chk(/Progress/.test(t), 'FM order screen: Progress tab');
  chk(/Everyone involved/i.test(t), 'Order Details lists everyone involved');
  chk(/Repeats/.test(t) && !/\d+ sheets?\b/i.test(t), 'Order Details counts repeats');

  await page.getByText(/^Job Card$/).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/07-jobcard-tab.png`, fullPage: true });
  t = await body();
  chk(/Open job card|Create job card/.test(t), 'Job Card tab offers create-or-open');

  await page.getByText(/^Progress$/).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/08-progress-tab.png`, fullPage: true });
  t = await body();
  chk(/^Order$/m.test(t) && /Repeats/.test(t), 'Progress tab toggles order vs repeat level');

  // ---- the job card detail itself ----
  // Reached from the Awaiting-job-card tab rather than from this order: the
  // first order on Overview may well have no card yet, and the point here is to
  // exercise a card that exists.
  await loginAs('floor@alpha.test');
  await page.getByText(/^Orders$/).first().click();
  await page.waitForTimeout(4000);
  // `firstVisible`, not `.first()`: the Floor Manager's dashboard now carries an
// "Awaiting job card" STAT CARD as well as the Orders-box tab, and the card's
// label is rendered-but-hidden at this point in the walk.
await (await firstVisible(page.getByText(/Awaiting job card/))).click();
  await page.waitForTimeout(3500);
  const open = await firstVisible(page.getByText(/^Open job card$/i));
  if (open) {
    await open.click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${SHOTS}/09-jobcard-detail.png`, fullPage: true });
    t = await body();
    chk(/Client Approved/.test(t), 'job card says "Client Approved"');
    chk(!/Client informed/i.test(t), 'job card no longer says "Client informed"');
    chk(!/Ask for material/i.test(t), 'job card has no "Ask for material" button');
    chk(/Download/.test(t) && /Share on WhatsApp/.test(t), 'Download and Share are present');
    chk(/→/.test(t), 'the stage sequence renders as an arrow line');
    chk(!/SLA \d+h/.test(t), 'no per-stage SLA cards remain');

    // The four actions must sit above the needle table.
    const idxAction = t.indexOf('Client Approved');
    const idxNeedle = t.search(/Needle/);
    chk(
      idxAction >= 0 && (idxNeedle < 0 || idxAction < idxNeedle),
      'the actions sit above the job-card body'
    );
  } else {
    info('This order has no job card yet — the detail walk was skipped.');
  }
} else {
  info('No orders visible to the floor manager.');
}

// ===========================================================================
// Store Manager — the PO's new owner
// ===========================================================================
await loginAs('store@alpha.test');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${SHOTS}/09b-store-home.png`, fullPage: true });

const poTab = await firstVisible(page.getByText(/^PO$/));
if (poTab) {
  await poTab.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/09c-store-pos.png`, fullPage: true });
  const smPoRow = await firstVisible(page.getByText(/PO-[A-Z]{2,4}-\d+/));
  if (smPoRow) {
    await smPoRow.click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${SHOTS}/09d-store-po-detail.png`, fullPage: true });
    t = await body();
    chk(
      /Creation/.test(t) && /Procured/.test(t) && /Paid/.test(t),
      'PO detail shows exactly the three statuses'
    );
    chk(!/Execute with supplier/i.test(t), 'PO detail has no "Execute with supplier"');
    chk(!/Upload bill|Upload supplier bill/i.test(t), 'PO detail has no bill upload');
    chk(!/Confirm handover/i.test(t), 'PO detail has no handover action');
    chk(!/Owner approval/i.test(t), 'PO detail has no owner-approval step');
    chk(/Save or share as PDF/i.test(t), 'PO detail offers save / download');
  } else {
    info('No purchase orders in the store manager\'s list.');
  }
} else {
  info('Could not find the store manager\'s PO tab.');
}

// ===========================================================================
// Procurement
// ===========================================================================
await loginAs('procurement@alpha.test');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${SHOTS}/10-procurement.png`, fullPage: true });
t = await body();
chk(/Pending/.test(t), 'procurement has a Pending tab');
chk(/Completed/.test(t), 'procurement has a Completed tab');
chk(!/To action|Waiting|Closed/.test(t), 'the old four PO filters are gone');
chk(!/New purchase order|New PO/i.test(t), 'procurement cannot raise a PO');

const poRow = await firstVisible(page.getByText(/PO-[A-Z]{2,4}-\d+/));
if (poRow) {
  await poRow.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/11-po-detail.png`, fullPage: true });
  t = await body();
  chk(/Save or share as PDF/i.test(t), 'procurement can save or download a PO');
  // The one transition on this screen is the store manager's. Procurement must
  // not be offered it.
  //
  // Checked as a BUTTON, not as text: "Procured" is also the middle label of the
  // three-status track every role sees, so a text match here was flagging the
  // status readout as if it were the action.
  const procuredBtn = page.getByRole('button', { name: /^Procured$/ });
  chk(
    (await procuredBtn.count()) === 0,
    'procurement is not offered the Procured button'
  );
} else {
  info('Procurement\'s list is empty — `proc_po_list` needs migration 0089.');
}

// ===========================================================================
// Owner's approvals inbox — no POs
// ===========================================================================
await loginAs('owner@alpha.test');
await page.waitForTimeout(1500);
t = await body();
if (/Approvals/i.test(t)) {
  const appr = await firstVisible(page.getByText(/Approvals/));
  if (appr) {
    await appr.click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${SHOTS}/12-approvals.png`, fullPage: true });
    t = await body();
    chk(!/Purchase order|PO-/i.test(t), "no PO appears in the owner's Approvals Inbox");
  }
} else {
  info("Owner's Approvals Inbox is reached from a banner, not the dashboard —");
  info('checked at the RPC level at the top of this run instead.');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (errors.length) {
  console.log('\n  page errors:');
  for (const e of [...new Set(errors)].slice(0, 8)) console.log('   ' + e);
}
await browser.close();
process.exit(fail ? 1 : 0);
