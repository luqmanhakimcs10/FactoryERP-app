-- =============================================================================
-- Factory ERP — remove throwaway rows left by scripts/verify-tenancy.mjs.
--
-- !!! DEVELOPMENT DATABASES ONLY. Never run against production. !!!
--
-- Why this exists as a maintenance script rather than script cleanup:
-- submitted orders are intentionally NOT deletable through the API. The RLS
-- delete policy on `orders` only matches status='draft', because an order with
-- coded repeats and stage history is a business record. Rather than weaken that
-- rule so a test could tidy up after itself, cleanup runs here as the DB owner.
--
-- Only touches rows whose vendor name carries a test marker, so hand-made demo
-- data is left alone. Child rows (sheets, repeats, history, job cards, damage,
-- POs) cascade from orders.
--
-- Run via the session pooler:
--   psql "postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
--        -f supabase/maintenance/cleanup_test_data.sql
-- =============================================================================

begin;

-- Orders belonging to test vendors.
delete from public.orders o
using public.vendors v
where v.id = o.vendor_id
  and (v.name like 'Spine %' or v.name like 'Probe %' or v.name like 'Smoke %');

-- Now the vendors themselves (safe: their orders are gone).
delete from public.vendors
where name like 'Spine %' or name like 'Probe %' or name like 'Smoke %';

-- Master rows created by the Phase 2 sections.
delete from public.finishing_partners where name like 'P-Alpha-%' or name like 'P-Beta-%';
delete from public.machines           where name like 'M-Alpha-%' or name like 'M-%-17%';
delete from public.suppliers          where name like 'S-Alpha-%' or name like 'S-%-17%';
delete from public.vendors            where name like 'V-Alpha-%' or name like 'Dup-%' or name like 'V-OT-%';

commit;

-- What's left:
select o.order_code, o.status, f.name as factory,
       (select count(*) from public.sheets s where s.order_id = o.id) as sheets,
       (select count(*) from public.repeats r
          join public.sheets s on s.id = r.sheet_id
         where s.order_id = o.id) as repeats
from public.orders o
join public.factories f on f.id = o.factory_id
order by o.order_code;
