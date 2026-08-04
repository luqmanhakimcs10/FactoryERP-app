-- =============================================================================
-- Factory ERP — defensive default for factory_id on master tables.
--
-- Why: every insert must land in the caller's own tenant. Relying on app code to
-- pass factory_id means a single forgotten field produces either a NOT NULL error
-- or, worse, a row attributed to the wrong place. Defaulting the column to
-- current_factory_id() makes correct tenancy the automatic outcome.
--
-- This is a convenience, NOT the guard: the RLS WITH CHECK
-- (factory_id = current_factory_id()) still rejects any forged value, so a
-- caller cannot override the default to point at another factory.
-- =============================================================================

alter table public.vendors
  alter column factory_id set default public.current_factory_id();

alter table public.suppliers
  alter column factory_id set default public.current_factory_id();

alter table public.machines
  alter column factory_id set default public.current_factory_id();

alter table public.finishing_partners
  alter column factory_id set default public.current_factory_id();
