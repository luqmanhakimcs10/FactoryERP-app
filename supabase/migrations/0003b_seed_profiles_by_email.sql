-- =============================================================================
-- Factory ERP — FALLBACK profile seed.
--
-- Use this ONLY if you created the test users manually in the Supabase Dashboard
-- (Authentication -> Users) instead of running 0003_seed_dev_users.sql.
-- Create users with these exact emails first, then run this to attach profiles.
-- Idempotent; safely skips emails that don't exist as auth users yet.
-- =============================================================================

insert into public.profiles (id, factory_id, role, display_name)
select u.id, v.factory_id, v.role, v.display_name
from (values
  ('super@erp.test',        null::uuid,                                     'super_admin',      'Platform Admin'),
  ('owner@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'company_admin',    'Alpha Owner'),
  ('accountant@alpha.test', '11111111-1111-1111-1111-111111111111'::uuid,  'accountant',       'Alpha Accountant'),
  ('floor@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'floor_manager',    'Alpha Floor Mgr'),
  ('store@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'store_manager',    'Alpha Store Mgr'),
  ('order@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'order_taker',      'Alpha Order Taker'),
  ('qa@alpha.test',         '11111111-1111-1111-1111-111111111111'::uuid,  'qa',               'Alpha QA'),
  ('procurement@alpha.test','11111111-1111-1111-1111-111111111111'::uuid,  'procurement',      'Alpha Procurement'),
  ('delivery@alpha.test',   '11111111-1111-1111-1111-111111111111'::uuid,  'delivery',         'Alpha Delivery'),
  ('worker@alpha.test',     '11111111-1111-1111-1111-111111111111'::uuid,  'worker',           'Alpha Worker'),
  ('partner@alpha.test',    '11111111-1111-1111-1111-111111111111'::uuid,  'finishing_partner','Alpha Partner'),
  ('owner@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'company_admin',    'Beta Owner'),
  ('accountant@beta.test',  '22222222-2222-2222-2222-222222222222'::uuid,  'accountant',       'Beta Accountant'),
  ('floor@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'floor_manager',    'Beta Floor Mgr'),
  ('store@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'store_manager',    'Beta Store Mgr'),
  ('order@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'order_taker',      'Beta Order Taker'),
  ('qa@beta.test',          '22222222-2222-2222-2222-222222222222'::uuid,  'qa',               'Beta QA'),
  ('procurement@beta.test', '22222222-2222-2222-2222-222222222222'::uuid,  'procurement',      'Beta Procurement'),
  ('delivery@beta.test',    '22222222-2222-2222-2222-222222222222'::uuid,  'delivery',         'Beta Delivery'),
  ('worker@beta.test',      '22222222-2222-2222-2222-222222222222'::uuid,  'worker',           'Beta Worker'),
  ('partner@beta.test',     '22222222-2222-2222-2222-222222222222'::uuid,  'finishing_partner','Beta Partner')
) as v(email, factory_id, role, display_name)
join auth.users u on u.email = v.email
on conflict (id) do update
  set factory_id = excluded.factory_id,
      role = excluded.role,
      display_name = excluded.display_name;
