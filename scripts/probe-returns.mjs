/** Throwaway probe: are the 4 verify:tenancy failures pre-existing, or mine? */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
const URL = env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const ALPHA = '11111111-1111-1111-1111-111111111111';

async function login(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!' }),
  });
  const j = await r.json().catch(() => null);
  return j?.access_token ?? null;
}
async function get(tok, path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  const body = await r.json().catch(() => null);
  return { status: r.status, body, rows: Array.isArray(body) ? body : null };
}

const sa = await login('super@erp.test');
const betaOwner = await login('owner@beta.test');
const owner = await login('owner@alpha.test');

const facs = await get(sa, 'factories?select=id,name,created_at&order=created_at');
console.log(`\n1. factories -> ${facs.rows?.length}`);
for (const f of facs.rows ?? []) console.log(`     ${f.name}  ${f.created_at}`);

const comp = await get(betaOwner, 'employee_compensation?select=id,factory_id');
const fids = new Set((comp.rows ?? []).map((c) => c.factory_id));
console.log(`\n4. Beta owner reads ${comp.rows?.length} employee_compensation row(s)`);
console.log(`   distinct factory_id: ${[...fids].join(', ')}`);
console.log(`   any belonging to ALPHA? ${fids.has(ALPHA) ? 'YES — REAL LEAK' : 'no — Beta own rows only'}`);

const mv = await get(owner, 'stock_movements?select=id,movement_type,ref_type,ref_id,created_at&order=created_at.desc&limit=300');
if (!mv.rows) {
  console.log(`\n3. stock_movements -> HTTP ${mv.status}: ${JSON.stringify(mv.body).slice(0, 160)}`);
} else {
  const unref = mv.rows.filter((m) => m.movement_type !== 'opening' && !m.ref_id);
  console.log(`\n3. stock_movements: ${mv.rows.length} recent, ${unref.length} non-opening without ref_id`);
  for (const m of unref.slice(0, 4)) console.log(`     ${m.movement_type}  ref_type=${m.ref_type}  ${m.created_at}`);
}

console.log('\nTables above (factories, employee_compensation, stock_movements) are untouched by 0053/0054/0055.');
