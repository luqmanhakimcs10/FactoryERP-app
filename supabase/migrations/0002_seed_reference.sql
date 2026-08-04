-- =============================================================================
-- Factory ERP — Phase 1 seed: roles, modules, two dummy factories.
-- Idempotent. Run AFTER 0001. Auth users + profiles come in 0003.
--
-- Two dummy factories exist from day one (anti-fraud checklist, spec §7.6):
-- every feature must be verified from BOTH tenants before it is called done.
-- =============================================================================

-- ---- Roles (the 11) ----
insert into public.roles (key, name) values
  ('super_admin',       'Super Admin'),
  ('company_admin',     'Owner'),
  ('accountant',        'Accountant'),
  ('floor_manager',     'Floor Manager'),
  ('store_manager',     'Store Manager'),
  ('order_taker',       'Order Taker'),
  ('qa',                'QA'),
  ('procurement',       'Procurement'),
  ('delivery',          'Delivery'),
  ('worker',            'Worker'),
  ('finishing_partner', 'Finishing Partner')
on conflict (key) do update set name = excluded.name;

-- ---- Modules (4 toggleable; auth/users/vendors/suppliers are core, not here) ----
insert into public.modules (key, name, is_core) values
  ('order_lifecycle',       'Order Lifecycle',        false),
  ('inventory_procurement', 'Inventory & Procurement', false),
  ('machine_workforce',     'Machine & Workforce',     false),
  ('finance_reports',       'Finance & Reports',       false)
on conflict (key) do update set name = excluded.name;

-- ---- Two dummy factories (fixed UUIDs so 0003 can reference them) ----
insert into public.factories (id, name, contact_email, contact_phone, plan) values
  ('11111111-1111-1111-1111-111111111111', 'Alpha Embroidery Works', 'owner@alpha.test', '+92-300-0000001', 'pro'),
  ('22222222-2222-2222-2222-222222222222', 'Beta Stitch House',      'owner@beta.test',  '+92-300-0000002', 'trial')
on conflict (id) do nothing;

-- ---- Module enablement per factory ----
-- Alpha: ALL modules enabled.
insert into public.factory_modules (factory_id, module_id, enabled, enabled_at)
select '11111111-1111-1111-1111-111111111111', m.id, true, now()
from public.modules m
on conflict (factory_id, module_id) do update
  set enabled = excluded.enabled, enabled_at = excluded.enabled_at;

-- Beta: Order Lifecycle + Inventory enabled; Machine & Workforce and Finance DISABLED
-- (so module-gating can be tested across the two tenants).
insert into public.factory_modules (factory_id, module_id, enabled, enabled_at)
select '22222222-2222-2222-2222-222222222222', m.id,
       (m.key in ('order_lifecycle', 'inventory_procurement')),
       case when m.key in ('order_lifecycle', 'inventory_procurement') then now() end
from public.modules m
on conflict (factory_id, module_id) do update
  set enabled = excluded.enabled, enabled_at = excluded.enabled_at;
