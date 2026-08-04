-- =============================================================================
-- Factory ERP — Super Admin: factory management, billing, and narrow inventory
-- visibility.
--
-- THE SECURITY POINT OF THIS MIGRATION:
-- The brief assumes super_admin has no access to business data. It did not.
-- Every SELECT policy written in Phases 3, 4 and 7 ended with
-- `or public.is_super_admin()`, so super_admin could read orders, repeats, job
-- cards, invoices, payments, expenses — everything. That contradicts both this
-- brief and the original spec (§2: "Super admin never touches business data").
--
-- So this migration does two opposite things deliberately:
--   1. REVOKES super_admin's read on every business table.
--   2. GRANTS it back on exactly two: thread_stock and stock_movements, read-only.
--
-- The revoke is done by rewriting each policy as `(original) and not
-- is_super_admin()`. For a normal user `is_super_admin()` is false, so their
-- access is unchanged; for super_admin the whole condition collapses to false.
-- Doing it this way means no policy's real logic has to be restated (and
-- therefore cannot be mistyped).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Factory billing + contact fields
-- ---------------------------------------------------------------------------
alter table public.factories
  add column if not exists representative_name text,
  add column if not exists phone               text,
  add column if not exists address             text,
  add column if not exists subscription_amount numeric(14,2) not null default 0,
  add column if not exists subscription_status text not null default 'unpaid',
  add column if not exists account_status      text not null default 'active',
  add column if not exists next_billing_date   date;

alter table public.factories drop constraint if exists factories_subscription_status_chk;
alter table public.factories add constraint factories_subscription_status_chk
  check (subscription_status in ('paid','unpaid'));

alter table public.factories drop constraint if exists factories_account_status_chk;
alter table public.factories add constraint factories_account_status_chk
  check (account_status in ('active','inactive'));

-- ---------------------------------------------------------------------------
-- 2. Thread stock display fields (color_code + quantity_meters already exist)
-- ---------------------------------------------------------------------------
alter table public.thread_stock
  add column if not exists color_name text,
  add column if not exists photo_url  text;

-- ---------------------------------------------------------------------------
-- 3. Revoke super_admin's blanket read on business data
-- ---------------------------------------------------------------------------
do $$
declare
  t    text;
  pol  record;
  business_tables text[] := array[
    -- order spine (Phase 3)
    'orders','order_stages','sheets','repeats','repeat_stage_history',
    'job_cards','job_card_lines','damage_records',
    -- masters (Phase 2) — reference data, still business data
    'vendors','suppliers','machines','finishing_partners',
    -- procurement & inventory documents (Phase 4) — NOT thread_stock/stock_movements
    'purchase_orders','po_items','grns','grn_items',
    'material_issues','material_issue_items','stock_audits','stock_audit_items',
    -- workforce & payroll (Phase 5)
    'shifts','downtime_reports','worker_ledger','bonus_slabs','leaves',
    -- finishing (Phase 6)
    'sla_alerts',
    -- finance (Phase 7)
    'invoices','expenses','payments','loans','partner_ledger','bonus_slab_proposals',
    -- access control metadata
    'user_permissions'
  ];
begin
  foreach t in array business_tables
  loop
    if to_regclass('public.' || t) is null then
      continue;   -- table from a phase not present in this database
    end if;

    for pol in
      select policyname, qual, cmd
      from pg_policies
      where schemaname = 'public' and tablename = t and cmd = 'SELECT'
    loop
      -- Only rewrite policies that actually grant super_admin something.
      if pol.qual is null or position('is_super_admin' in pol.qual) = 0 then
        continue;
      end if;

      execute format('drop policy if exists %I on public.%I', pol.policyname, t);
      execute format(
        'create policy %I on public.%I for select to authenticated using ((%s) and not public.is_super_admin())',
        pol.policyname, t, pol.qual);
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Grant super_admin READ on exactly two tables
--
-- Separate, additively-named policies rather than edits to the existing ones, so
-- the scope of super_admin's access is greppable in one place and cannot widen
-- by accident when a store-manager policy is next changed.
-- ---------------------------------------------------------------------------
drop policy if exists thread_stock_super_admin_read on public.thread_stock;
create policy thread_stock_super_admin_read on public.thread_stock
  for select to authenticated
  using (public.is_super_admin());

drop policy if exists stock_movements_super_admin_read on public.stock_movements;
create policy stock_movements_super_admin_read on public.stock_movements
  for select to authenticated
  using (public.is_super_admin());

-- No INSERT/UPDATE/DELETE policy is added for super_admin on either table.
-- Write access stays exactly as Phase 4 left it: the store manager's RPCs only.

-- ---------------------------------------------------------------------------
-- 5. Create a factory and its modules in ONE step
-- ---------------------------------------------------------------------------
/**
 * Replaces the old two-step "create factory, then go to Module Toggle" flow for
 * initial setup: a factory created here is immediately usable.
 *
 * Defaults per the brief: account_status active, subscription_status unpaid.
 */
create or replace function public.sa_create_factory(
  p_name                text,
  p_representative_name text default null,
  p_phone               text default null,
  p_address             text default null,
  p_subscription_amount numeric default 0,
  p_module_keys         text[] default '{}',
  p_next_billing_date   date default null
)
returns public.factories
language plpgsql security definer set search_path = public as $$
declare
  v_factory public.factories;
  v_prefix  text;
begin
  if not public.is_super_admin() then
    raise exception 'Only the platform administrator can create factories.'
      using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Factory name is required.' using errcode = '22023';
  end if;

  v_prefix := upper(substring(regexp_replace(p_name, '[^A-Za-z0-9]', '', 'g') from 1 for 3));
  if coalesce(v_prefix, '') = '' then
    raise exception 'Factory name must contain at least one letter or digit.' using errcode = '22023';
  end if;

  insert into public.factories
    (name, code_prefix, representative_name, phone, address,
     subscription_amount, subscription_status, account_status, next_billing_date)
  values
    (trim(p_name), v_prefix, nullif(trim(p_representative_name), ''),
     nullif(trim(p_phone), ''), nullif(trim(p_address), ''),
     coalesce(p_subscription_amount, 0), 'unpaid', 'active', p_next_billing_date)
  returning * into v_factory;

  insert into public.factory_counters (factory_id) values (v_factory.id)
  on conflict (factory_id) do nothing;

  -- Selected modules are enabled immediately; the rest are recorded as disabled
  -- so the Module Toggle screen has a complete row set to work from later.
  insert into public.factory_modules (factory_id, module_id, enabled, enabled_at)
  select v_factory.id, m.id,
         m.key = any(coalesce(p_module_keys, '{}')),
         case when m.key = any(coalesce(p_module_keys, '{}')) then now() end
  from public.modules m
  on conflict (factory_id, module_id) do update
    set enabled = excluded.enabled, enabled_at = excluded.enabled_at;

  return v_factory;
end $$;

/** Update a factory's billing / contact details. */
create or replace function public.sa_update_factory(
  p_factory_id          uuid,
  p_representative_name text default null,
  p_phone               text default null,
  p_address             text default null,
  p_subscription_amount numeric default null,
  p_subscription_status text default null,
  p_next_billing_date   date default null
)
returns public.factories
language plpgsql security definer set search_path = public as $$
declare v_f public.factories;
begin
  if not public.is_super_admin() then
    raise exception 'Only the platform administrator can edit factories.' using errcode = '42501';
  end if;

  update public.factories
     set representative_name = coalesce(p_representative_name, representative_name),
         phone               = coalesce(p_phone, phone),
         address             = coalesce(p_address, address),
         subscription_amount = coalesce(p_subscription_amount, subscription_amount),
         subscription_status = coalesce(p_subscription_status, subscription_status),
         next_billing_date   = coalesce(p_next_billing_date, next_billing_date)
   where id = p_factory_id
  returning * into v_f;

  if not found then perform public.raise_not_found('Factory not found.'); end if;
  return v_f;
end $$;

/** Flip a factory active/inactive. Inactive blocks login for all its users. */
create or replace function public.sa_set_account_status(
  p_factory_id uuid,
  p_active     boolean
)
returns public.factories
language plpgsql security definer set search_path = public as $$
declare v_f public.factories;
begin
  if not public.is_super_admin() then
    raise exception 'Only the platform administrator can change account status.'
      using errcode = '42501';
  end if;

  update public.factories
     set account_status = case when p_active then 'active' else 'inactive' end
   where id = p_factory_id
  returning * into v_f;

  if not found then perform public.raise_not_found('Factory not found.'); end if;
  return v_f;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Super-admin reads
-- ---------------------------------------------------------------------------
/**
 * Factory list with billing, module count and user count.
 * Deliberately returns no business figures — only tenancy and billing.
 */
create or replace function public.sa_factory_list()
returns table (
  id                  uuid,
  name                text,
  code_prefix         text,
  representative_name text,
  phone               text,
  address             text,
  subscription_amount numeric,
  subscription_status text,
  account_status      text,
  next_billing_date   date,
  active_modules      int,
  user_count          int,
  created_at          timestamptz
)
language sql stable security definer set search_path = public as $$
  select f.id, f.name, f.code_prefix, f.representative_name, f.phone, f.address,
         f.subscription_amount, f.subscription_status, f.account_status,
         f.next_billing_date,
         (select count(*)::int from public.factory_modules fm
           where fm.factory_id = f.id and fm.enabled),
         (select count(*)::int from public.profiles p where p.factory_id = f.id),
         f.created_at
  from public.factories f
  where public.is_super_admin()
  order by f.name
$$;

/** The four modules with their enabled state for one factory. */
create or replace function public.sa_factory_modules(p_factory_id uuid)
returns table (module_id uuid, key text, name text, enabled boolean)
language sql stable security definer set search_path = public as $$
  select m.id, m.key, m.name, coalesce(fm.enabled, false)
  from public.modules m
  left join public.factory_modules fm
         on fm.module_id = m.id and fm.factory_id = p_factory_id
  where public.is_super_admin()
  order by m.name
$$;

create or replace function public.sa_toggle_module(
  p_factory_id uuid,
  p_module_key text,
  p_enabled    boolean
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_module uuid;
begin
  if not public.is_super_admin() then
    raise exception 'Only the platform administrator can change modules.' using errcode = '42501';
  end if;

  select id into v_module from public.modules where key = p_module_key;
  if v_module is null then perform public.raise_not_found('Module not found.'); end if;

  insert into public.factory_modules (factory_id, module_id, enabled, enabled_at)
  values (p_factory_id, v_module, p_enabled, case when p_enabled then now() end)
  on conflict (factory_id, module_id) do update
    set enabled = excluded.enabled, enabled_at = excluded.enabled_at;

  return jsonb_build_object('factory_id', p_factory_id, 'module', p_module_key, 'enabled', p_enabled);
end $$;

/**
 * Read-only thread stock for one factory, plus that factory's last audit date.
 *
 * Last audit is DERIVED, not stored: the newest `audit_variance` movement for
 * the factory (Phase 4 already writes those). NULL when no audit has ever run,
 * which the UI must show as "no audit yet" rather than a blank or a wrong date.
 */
create or replace function public.sa_factory_inventory(p_factory_id uuid)
returns table (
  id              uuid,
  color_code      text,
  color_name      text,
  photo_url       text,
  quantity_meters numeric,
  last_audit_at   timestamptz
)
language sql stable security definer set search_path = public as $$
  select ts.id, ts.color_code, ts.color_name, ts.photo_url, ts.quantity_meters,
         (select max(m.created_at) from public.stock_movements m
           where m.factory_id = p_factory_id and m.movement_type = 'audit_variance')
  from public.thread_stock ts
  where ts.factory_id = p_factory_id
    and public.is_super_admin()
  order by ts.color_code
$$;

/** Last audit date on its own, so the tab header renders before the list loads. */
create or replace function public.sa_last_audit(p_factory_id uuid)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select max(m.created_at)
  from public.stock_movements m
  where m.factory_id = p_factory_id
    and m.movement_type = 'audit_variance'
    and public.is_super_admin()
$$;

-- ---------------------------------------------------------------------------
-- 7. Login gate for inactive factories
-- ---------------------------------------------------------------------------
/**
 * Whether the caller's own factory is active.
 *
 * The app calls this right after sign-in and signs the user straight back out
 * with a clear message when it returns false. Super admin has no factory and is
 * always allowed — otherwise deactivating a factory could lock out the only
 * account able to reactivate it.
 */
create or replace function public.my_factory_active()
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.is_super_admin() then true
    else coalesce(
      (select f.account_status = 'active'
         from public.factories f
        where f.id = public.current_factory_id()),
      false)
  end
$$;

grant execute on function public.sa_create_factory(text, text, text, text, numeric, text[], date) to authenticated;
grant execute on function public.sa_update_factory(uuid, text, text, text, numeric, text, date) to authenticated;
grant execute on function public.sa_set_account_status(uuid, boolean) to authenticated;
grant execute on function public.sa_factory_list() to authenticated;
grant execute on function public.sa_factory_modules(uuid) to authenticated;
grant execute on function public.sa_toggle_module(uuid, text, boolean) to authenticated;
grant execute on function public.sa_factory_inventory(uuid) to authenticated;
grant execute on function public.sa_last_audit(uuid) to authenticated;
grant execute on function public.my_factory_active() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Dev seed: give the two dummy factories plausible billing data
-- ---------------------------------------------------------------------------
update public.factories
   set representative_name = coalesce(representative_name, 'Imran Sheikh'),
       phone = coalesce(phone, '+92-300-0000001'),
       address = coalesce(address, 'SITE Area, Karachi'),
       subscription_amount = case when subscription_amount = 0 then 25000 else subscription_amount end,
       subscription_status = 'paid',
       next_billing_date = coalesce(next_billing_date, current_date + 30)
 where id = '11111111-1111-1111-1111-111111111111';

update public.factories
   set representative_name = coalesce(representative_name, 'Nadia Karim'),
       phone = coalesce(phone, '+92-300-0000002'),
       address = coalesce(address, 'Sundar Estate, Lahore'),
       subscription_amount = case when subscription_amount = 0 then 12000 else subscription_amount end,
       subscription_status = 'unpaid',
       next_billing_date = coalesce(next_billing_date, current_date + 7)
 where id = '22222222-2222-2222-2222-222222222222';

-- Colour names/photos so the inventory tab has something meaningful to show.
update public.thread_stock set color_name = case color_code
    when 'RED-01' then 'Crimson Red'
    when 'GLD-02' then 'Antique Gold'
    when 'BLK-03' then 'Jet Black'
    when 'WHT-04' then 'Pearl White'
    when 'NEW-77' then 'Sea Green'
    else initcap(replace(color_code, '-', ' '))
  end
 where color_name is null;

-- ---------------------------------------------------------------------------
-- 9. Dev seed: distinct last-audit dates per factory.
--
-- The inventory tab derives "last audit" from the newest `audit_variance`
-- movement. Without a real audit the tab shows "No audit yet"; these seeds give
-- each dummy factory one signed-off audit so the per-factory derivation is
-- testable. Written straight to the ledger (as sm_submit_audit does) with a
-- variance so a movement row exists.
-- ---------------------------------------------------------------------------
do $$
declare
  v_alpha_audit uuid;
  v_beta_audit  uuid;
begin
  if not exists (select 1 from public.stock_audits
                  where audit_code = public.make_code(
                    '11111111-1111-1111-1111-111111111111', 'AUD', 1)) then
    insert into public.stock_audits
      (factory_id, audit_code, audit_date, note, submitted_at)
    values
      ('11111111-1111-1111-1111-111111111111',
       public.make_code('11111111-1111-1111-1111-111111111111', 'AUD', 1),
       current_date - 3, 'Dev seed audit', current_date - 3)
    returning id into v_alpha_audit;

    insert into public.stock_audit_items
      (factory_id, stock_audit_id, color_code, expected_meters, actual_meters, variance_meters)
    select '11111111-1111-1111-1111-111111111111', v_alpha_audit, ts.color_code,
           ts.quantity_meters, ts.quantity_meters - 100, -100
    from public.thread_stock ts
    where ts.factory_id = '11111111-1111-1111-1111-111111111111'
    order by ts.color_code limit 1;

    insert into public.stock_movements
      (factory_id, thread_stock_id, color_code, movement_type, quantity_meters,
       balance_after, ref_type, ref_id, note, created_at)
    select '11111111-1111-1111-1111-111111111111', ts.id, ts.color_code,
           'audit_variance', -100, ts.quantity_meters - 100,
           'stock_audit', v_alpha_audit, 'Dev seed audit', current_date - 3
    from public.thread_stock ts
    where ts.factory_id = '11111111-1111-1111-1111-111111111111'
    order by ts.color_code limit 1;

    -- Keep the live balances consistent with the movements above (as
    -- log_stock_movement would), so the leakage report stays honest.
    update public.thread_stock ts
       set quantity_meters = quantity_meters - 100
     where ts.factory_id = '11111111-1111-1111-1111-111111111111'
       and ts.color_code = (
         select ts2.color_code from public.thread_stock ts2
          where ts2.factory_id = '11111111-1111-1111-1111-111111111111'
          order by ts2.color_code limit 1);
  end if;

  if not exists (select 1 from public.stock_audits
                  where audit_code = public.make_code(
                    '22222222-2222-2222-2222-222222222222', 'AUD', 1)) then
    insert into public.stock_audits
      (factory_id, audit_code, audit_date, note, submitted_at)
    values
      ('22222222-2222-2222-2222-222222222222',
       public.make_code('22222222-2222-2222-2222-222222222222', 'AUD', 1),
       current_date - 10, 'Dev seed audit', current_date - 10)
    returning id into v_beta_audit;

    insert into public.stock_audit_items
      (factory_id, stock_audit_id, color_code, expected_meters, actual_meters, variance_meters)
    select '22222222-2222-2222-2222-222222222222', v_beta_audit, ts.color_code,
           ts.quantity_meters, ts.quantity_meters + 50, 50
    from public.thread_stock ts
    where ts.factory_id = '22222222-2222-2222-2222-222222222222'
    order by ts.color_code limit 1;

    insert into public.stock_movements
      (factory_id, thread_stock_id, color_code, movement_type, quantity_meters,
       balance_after, ref_type, ref_id, note, created_at)
    select '22222222-2222-2222-2222-222222222222', ts.id, ts.color_code,
           'audit_variance', 50, ts.quantity_meters + 50,
           'stock_audit', v_beta_audit, 'Dev seed audit', current_date - 10
    from public.thread_stock ts
    where ts.factory_id = '22222222-2222-2222-2222-222222222222'
    order by ts.color_code limit 1;

    update public.thread_stock ts
       set quantity_meters = quantity_meters + 50
     where ts.factory_id = '22222222-2222-2222-2222-222222222222'
       and ts.color_code = (
         select ts2.color_code from public.thread_stock ts2
          where ts2.factory_id = '22222222-2222-2222-2222-222222222222'
          order by ts2.color_code limit 1);
  end if;
end $$;
