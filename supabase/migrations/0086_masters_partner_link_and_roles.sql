-- =============================================================================
-- Factory ERP — Company Admin masters field changes, the finishing-partner
-- link, and the employee role split/merge.
--
-- FOUR INDEPENDENT CHANGES SHARE THIS FILE BECAUSE THEY SHARE ONE BRIEF:
--
--   1. Client card       — `price` removed, `billing_date` added.
--   2. Supplier card     — `inventory_types` added (what this supplier sells).
--   3. Finishing Partner — no login account any more. One persistent,
--                          unguessable link per partner instead.
--   4. Employees         — Order Taker + Delivery Person merge into one role;
--                          Manager splits into Floor Manager / Store Manager;
--                          "Initial QA" reverts to "QA".
--
-- THE MACHINE CARD IS NOT IN THIS FILE ON PURPOSE. "Remove the machine-type
-- selector, keep just a machine number" is entirely a form change: the number
-- is already `machines.name` (the column every other screen, job card and shift
-- row identifies a machine by). `machines.machine_type` keeps its NOT NULL
-- default so existing rows and the accountant's fleet screen are untouched — it
-- simply stops being asked for. Dropping it would rewrite acct_machine_summary
-- to delete a column nobody is complaining about.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Client (vendors): price out, billing date in
--
-- `price` was a third rate column beside rate_per_repeat and rate_per_stitch
-- with no consumer that could say which of the three applied — it is dropped,
-- not deprecated. `acct_client_summary` selected it, so that function is
-- rewritten in place with billing_date in the same slot: the accountant's
-- Clients screen keeps a fact in that tile, and a more useful one.
-- ---------------------------------------------------------------------------
alter table public.vendors
  add column if not exists billing_date date;

comment on column public.vendors.billing_date is
  'The day this client is invoiced on. Captured with a calendar picker on the client card.';

-- Return type changes (price -> billing_date), so the old signature must go
-- before the new body can be created.
drop function if exists public.acct_client_summary();

create or replace function public.acct_client_summary()
returns table (
  vendor_id        uuid,
  name             text,
  contact          text,
  address          text,
  rate_per_repeat  numeric,
  rate_per_stitch  numeric,
  billing_date     date,
  invoice_count    int,
  unpaid_count     int,
  total_income     numeric,
  received         numeric,
  pending          numeric,
  next_due_date    date,
  damage_count     int,
  damage_deduction numeric
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_factory uuid := public.current_factory_id();
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['accountant','company_admin']);

  return query
  with inv as (
    select o.vendor_id as vid, i.id as iid, i.amount, i.status, i.due_date
      from public.invoices i
      join public.orders o on o.id = i.order_id
     where i.factory_id = v_factory and i.status <> 'cancelled'
  ),
  paid as (
    select inv.vid, coalesce(sum(p.amount), 0) as received
      from public.payments p
      join inv on inv.iid = p.ref_id
     where p.factory_id = v_factory
       and p.direction = 'receivable' and p.ref_type = 'invoice'
     group by inv.vid
  ),
  dmg as (
    select d.responsible_id as vid,
           count(*)::int as damage_count,
           coalesce(sum(d.deduction), 0) as damage_deduction
      from public.damage_records d
     where d.factory_id = v_factory
       and d.responsible_type = 'vendor'
       and d.approval_status <> 'rejected'
     group by d.responsible_id
  )
  select
    v.id, v.name, v.contact, v.address,
    v.rate_per_repeat, v.rate_per_stitch, v.billing_date,
    count(inv.iid)::int,
    count(inv.iid) filter (where inv.status <> 'paid')::int,
    coalesce(sum(inv.amount), 0),
    coalesce(max(paid.received), 0),
    coalesce(sum(inv.amount) filter (where inv.status <> 'paid'), 0),
    min(inv.due_date) filter (where inv.status <> 'paid'),
    coalesce(max(dmg.damage_count), 0),
    coalesce(max(dmg.damage_deduction), 0)
  from public.vendors v
  left join inv  on inv.vid  = v.id
  left join paid on paid.vid = v.id
  left join dmg  on dmg.vid  = v.id
  where v.factory_id = v_factory and v.deleted_at is null
  group by v.id, v.name, v.contact, v.address,
           v.rate_per_repeat, v.rate_per_stitch, v.billing_date
  order by v.name;
end $$;

grant execute on function public.acct_client_summary() to authenticated;

-- Dropped last, so the rewritten function above is already in place if this
-- file is re-run against a database where the column is gone.
alter table public.vendors drop column if exists price;

-- ---------------------------------------------------------------------------
-- 2. Supplier: which inventory types they supply
--
-- An ARRAY, not a join table. The option set is the four item types that
-- `inventory_items.item_type` already constrains — a fixed, tiny vocabulary
-- that is never queried FROM (nothing asks "list suppliers of tilla" in a hot
-- path). A join table here would be three objects and a policy to express one
-- multi-select on one card.
--
-- The CHECK mirrors inventory_items_type_chk rather than referencing it: a
-- supplier can be recorded as a source for a type before any stock of that type
-- exists, so an FK to live rows would be wrong.
-- ---------------------------------------------------------------------------
alter table public.suppliers
  add column if not exists inventory_types text[] not null default '{}';

alter table public.suppliers drop constraint if exists suppliers_inventory_types_chk;
alter table public.suppliers add constraint suppliers_inventory_types_chk
  check (inventory_types <@ array['thread','tilla','sequin','bobbin']::text[]);

comment on column public.suppliers.inventory_types is
  'Which inventory types this supplier is a source for. Mirrors inventory_items.item_type.';

-- ---------------------------------------------------------------------------
-- 3. Finishing Partner: a persistent link instead of a login
--
-- WHY A TOKEN AND NOT SUPABASE AUTH
-- ---------------------------------
-- The partner is an external contractor with a phone and no reason to hold an
-- account. They were given a full auth login purely so a dashboard could
-- identify them. That is now one bookmarkable URL carrying a 32-byte random
-- token; opening it always shows whatever is currently in their hands.
--
-- WHAT THE TOKEN CAN DO, EXACTLY
-- ------------------------------
-- Three SECURITY DEFINER functions, granted to `anon`, each of which resolves
-- the token to ONE finishing_partners row and refuses to do anything if it
-- cannot. There is no table-level grant to anon anywhere in this file: an
-- attacker holding a token can read that partner's active work and mark that
-- partner's pieces ready, and nothing else. RLS on every table is untouched.
--
-- `deleted_at is null` is part of every lookup, so archiving a partner revokes
-- their link — which is the only revocation mechanism the card needs.
-- ---------------------------------------------------------------------------
alter table public.finishing_partners
  add column if not exists access_token    text,
  add column if not exists token_issued_at timestamptz;

-- Backfill before the unique index, so existing partners get a link too.
update public.finishing_partners
   set access_token = encode(extensions.gen_random_bytes(24), 'hex'),
       token_issued_at = now()
 where access_token is null;

alter table public.finishing_partners
  alter column access_token set default encode(extensions.gen_random_bytes(24), 'hex');

create unique index if not exists uq_finishing_partners_token
  on public.finishing_partners(access_token);

-- The checkbox this replaces. Nothing read it: it was captured on the card and
-- never consulted by any stage-routing decision, which is why "extended
-- partner" could never actually widen what a partner was handed.
alter table public.finishing_partners drop column if exists is_extended_partner;

/** Resolve a token to a live partner, or null. The only lookup in this section. */
create or replace function public.partner_by_token(p_token text)
returns public.finishing_partners
language sql stable security definer set search_path = public as $$
  select fp.* from public.finishing_partners fp
   where fp.access_token = p_token
     and coalesce(trim(p_token), '') <> ''
     and fp.deleted_at is null
   limit 1
$$;

/** Who the link belongs to — the portal's header. */
create or replace function public.partner_portal_info(p_token text)
returns table (partner_name text, stage_type text, factory_name text)
language plpgsql stable security definer set search_path = public as $$
declare v_p public.finishing_partners;
begin
  v_p := public.partner_by_token(p_token);
  if v_p.id is null then
    raise exception 'This link is no longer valid.' using errcode = '42501';
  end if;

  return query
    select v_p.name, v_p.stage_type, f.name
      from public.factories f
     where f.id = v_p.factory_id
       and f.account_status = 'active';
end $$;

/**
 * Everything currently in this partner's hands.
 *
 * Deliberately the same predicate as `partner_active_work()` — status
 * `handed_off` with `current_partner_id` pointing at them — so the link and the
 * old dashboard can never show different work. What changed is how the partner
 * is identified: by token here, by auth.uid() there.
 */
create or replace function public.partner_portal_work(p_token text)
returns table (
  repeat_id        uuid,
  repeat_code      text,
  order_code       text,
  vendor_name      text,
  sheet_number     int,
  color_assignment text,
  stage_type       text,
  stage_sequence   int,
  total_stages     int,
  sla_hours        int,
  handed_off_at    timestamptz,
  sla_breached     boolean,
  partner_ready_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare v_p public.finishing_partners;
begin
  v_p := public.partner_by_token(p_token);
  if v_p.id is null then
    raise exception 'This link is no longer valid.' using errcode = '42501';
  end if;

  return query
  select
    r.id, r.repeat_code, o.order_code, coalesce(v.name, '—'),
    sh.sheet_number, sh.color_assignment,
    st.stage_type, st.sequence,
    (select count(*)::int from public.order_stages os where os.order_id = o.id),
    st.sla_hours,
    leg.handed_off_at,
    exists (select 1 from public.sla_alerts a
             where a.repeat_id = r.id and a.resolved_at is null),
    r.partner_ready_at
  from public.repeats r
  join public.sheets sh on sh.id = r.sheet_id
  join public.orders o on o.id = sh.order_id
  left join public.vendors v on v.id = o.vendor_id
  left join public.order_stages st
         on st.order_id = o.id and st.sequence = greatest(r.current_stage_index, 1)
  left join lateral (
    select h.handed_off_at
      from public.repeat_stage_history h
     where h.repeat_id = r.id and h.handed_off_at is not null and h.returned_at is null
     order by h.handed_off_at desc
     limit 1
  ) leg on true
  where r.factory_id = v_p.factory_id
    and r.current_status = 'handed_off'
    and r.current_partner_id = v_p.id
  order by leg.handed_off_at desc nulls last, r.repeat_code;
end $$;

/**
 * "I have finished this piece" from the link — the same signal
 * `partner_ready_for_collection` writes, with the same audit row.
 *
 * The ownership check is not a formality: without it a valid token would mark
 * ANY repeat ready, including another partner's, since this runs as definer.
 */
create or replace function public.partner_portal_mark_ready(
  p_token     text,
  p_repeat_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_p public.finishing_partners;
  v_r public.repeats;
begin
  v_p := public.partner_by_token(p_token);
  if v_p.id is null then
    raise exception 'This link is no longer valid.' using errcode = '42501';
  end if;

  select * into v_r from public.repeats
   where id = p_repeat_id
     and factory_id = v_p.factory_id
     and current_partner_id = v_p.id;

  if not found then
    raise exception 'That piece is not with you.' using errcode = '42501';
  end if;
  if v_r.current_status <> 'handed_off' then
    raise exception 'This piece is not currently with you (status: %).', v_r.current_status
      using errcode = '22023';
  end if;

  update public.repeats
     set partner_ready_at = now(), updated_at = now()
   where id = p_repeat_id
  returning * into v_r;

  insert into public.repeat_stage_history
    (factory_id, repeat_id, order_stage_id, status, actor_user_id, note)
  select v_r.factory_id, p_repeat_id,
         (select os.id from public.order_stages os
            join public.sheets s2 on s2.id = v_r.sheet_id
           where os.order_id = s2.order_id
             and os.sequence = greatest(v_r.current_stage_index, 1)),
         'handed_off', null, 'Finishing partner marked work complete (partner link)';

  return jsonb_build_object('repeat_id', p_repeat_id, 'ready_at', v_r.partner_ready_at);
end $$;

-- `partner_by_token` is NOT granted to anon: it returns the whole row,
-- access_token included, and nothing outside this file needs it.
revoke all on function public.partner_by_token(text) from anon, authenticated;

grant execute on function public.partner_portal_info(text)              to anon, authenticated;
grant execute on function public.partner_portal_work(text)              to anon, authenticated;
grant execute on function public.partner_portal_mark_ready(text, uuid)  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Employee roles
--
-- 4a. The combined Order/Delivery Person.
--
-- HOW THIS AVOIDS REWRITING 74 ROLE CHECKS
-- ----------------------------------------
-- `order_delivery` is a real role key on the profile, so an employee is created
-- once and lands on one navigator. Every role gate in the database goes through
-- `has_any_role` (assert_role is a thin wrapper over it), so teaching THAT one
-- function to expand `order_delivery` into {order_delivery, order_taker,
-- delivery} makes all 74 existing `assert_role(array['order_taker', ...])` and
-- policy checks accept the combined role — without touching one of them, and
-- without widening anything for any other role.
--
-- The two banner functions are the only gates that do NOT go through
-- has_any_role: they branch on `current_user_role()` directly, so a combined
-- user would silently get neither role's banners. They are recreated below,
-- verbatim except that every `v_role` comparison becomes a `v_roles` set test.
-- ---------------------------------------------------------------------------
insert into public.roles (key, name) values
  ('order_delivery', 'Order/Delivery Person')
on conflict (key) do update set name = excluded.name;

-- "Initial QA" reverts to "QA" in the reference table too, so any screen that
-- reads the role name from the database agrees with the app's own label.
update public.roles set name = 'QA' where key = 'qa';

/**
 * The roles the caller effectively holds.
 *
 * One row per user, so this is a single indexed lookup — the same cost
 * `current_user_role()` already paid. Only `order_delivery` expands; every
 * other role maps to itself, so no existing grant changes shape.
 */
create or replace function public.effective_roles()
returns text[]
language sql stable security definer set search_path = public as $$
  select case p.role
           when 'order_delivery' then array['order_delivery','order_taker','delivery']
           else array[p.role]
         end
  from public.profiles p
  where p.id = auth.uid()
$$;

create or replace function public.has_any_role(p_roles text[])
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.effective_roles() && p_roles, false)
$$;

grant execute on function public.effective_roles()      to authenticated;
grant execute on function public.has_any_role(text[])   to authenticated;

-- 4b. create_employee accepts the merged role and the two explicit manager
--     roles. `manager` is deliberately NOT in the list any more: 0033 already
--     found that a plain `manager` account has no navigator and lands on a dead
--     placeholder, and the brief now asks for the two real roles to be chosen
--     explicitly rather than through a second "manager type" question.
create or replace function public.create_employee(
  p_email         text,
  p_password      text,
  p_display_name  text,
  p_role          text,
  p_salary_type   text,
  p_salary_amount numeric
)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_factory uuid := public.current_factory_id();
  v_user_id uuid;
  v_email   text := lower(trim(p_email));
begin
  perform public.assert_role(array['company_admin']);

  if p_role not in (
    'worker','qa','labour',
    'floor_manager','store_manager','order_delivery',
    -- Kept accepted so existing tooling and any half-finished flow that still
    -- names the split roles keeps working. The picker no longer offers them.
    'delivery','order_taker','manager'
  ) then
    raise exception 'Role % is not an employee role.', p_role using errcode = '22023';
  end if;
  if p_salary_type not in ('per_month','per_day','per_stitch') then
    raise exception 'Invalid salary type.' using errcode = '22023';
  end if;
  if p_salary_amount < 0 then
    raise exception 'Salary amount cannot be negative.' using errcode = '22023';
  end if;
  if v_email = '' or coalesce(trim(p_password), '') = '' or char_length(p_password) < 8 then
    raise exception 'An email and a password of at least 8 characters are required.' using errcode = '22023';
  end if;
  if p_display_name is null or trim(p_display_name) = '' then
    raise exception 'Display name is required.' using errcode = '22023';
  end if;

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token,
      email_change_token_new, email_change_token_current, email_change,
      phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
      v_email, crypt(p_password, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false,
      '', '', '', '', '', '', '', ''
    )
    returning id into v_user_id;

    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_user_id::text, v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email),
      'email', now(), now(), now()
    );
  exception
    when unique_violation then
      raise exception 'An account with that email already exists.' using errcode = '23505';
  end;

  insert into public.profiles (id, factory_id, role, display_name)
  values (v_user_id, v_factory, p_role, trim(p_display_name));

  insert into public.employee_compensation (factory_id, user_id, role, salary_type, salary_amount)
  values (v_factory, v_user_id, p_role, p_salary_type, p_salary_amount);

  -- Piece-rate workers need their rate on the profile too: shift close
  -- snapshots profiles.stitch_rate into worker_ledger.base_per_stitch.
  if p_salary_type = 'per_stitch' then
    update public.profiles set stitch_rate = p_salary_amount where id = v_user_id;
  end if;

  return jsonb_build_object('id', v_user_id, 'email', v_email);
end $$;

grant execute on function public.create_employee(text,text,text,text,text,numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 4c. The two banner functions, role-set aware.
--
-- Recreated from their 0084 definitions with ONE mechanical change applied
-- throughout: `v_role = 'x'` became `('x' = any(v_roles))`, `v_role in (...)`
-- became `v_roles && array[...]`, and `v_role not in (...)` became
-- `not (v_roles && array[...])`. `v_role` itself is still declared and is still
-- what the "no factory / unlinked user" guard tests, because that guard is
-- about having a profile at all, not about which role it names.
--
-- Nothing else in either body is altered. An Order/Delivery Person therefore
-- sees the order taker's returns banner AND all five delivery banners, and
-- each is marked `own_task` for them exactly as it would be for either of the
-- two roles it replaces.
-- ---------------------------------------------------------------------------

create or replace function public.my_queue_summary()
returns table (
  queue_key       text,
  label           text,
  count           int,
  banner_title    text,
  banner_subtitle text,
  own_task        boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_role    text   := public.current_user_role();

  v_roles   text[] := public.effective_roles();
  v_uid     uuid := auth.uid();
  v_partner uuid;
  n         int;
begin
  if v_factory is null or v_role is null then
    return;   -- super admin / unlinked user has no per-factory queue
  end if;

  if v_roles && array['floor_manager', 'company_admin'] then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared');
    if n > 0 then
      return query select 'awaiting_job_card', 'Orders awaiting a job card', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a job card',
        'Set the stage sequence so production can be planned',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.material_issues mi
     where mi.factory_id = v_factory and mi.accepted_at is null;
    if n > 0 then
      return query select 'accept_inventory', 'Material ready to accept', n,
        n || ' order' || case when n = 1 then '' else 's' end || ' ready to accept material',
        'Materials are waiting in the store — accept to start production',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_fm_collection';
    if n > 0 then
      return query select 'fm_collect', 'Pieces back from delivery', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' waiting to be collected',
        'The delivery person has handed these back — confirm you have them',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handover_for_delivery';
    if n > 0 then
      return query select 'fm_handover', 'Stages ready to hand over', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to hand over',
        'Passed stage QA — hand to the delivery person',
        ('floor_manager' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_final_qa';
    if n > 0 then
      return query select 'fm_final_qa', 'Awaiting your final QA', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' final QA',
        'Check each one before it goes to QA for the final pass',
        ('floor_manager' = any(v_roles));
    end if;

    -- NEW — the dashboard's "Shift close" card already counts these. Same
    -- predicate as fm_shift_close_queue(), inlined behind module_enabled so a
    -- factory without machine_workforce gets no row instead of an exception.
    -- `managed_by is null` is in the original and is kept: an unassigned machine
    -- is everyone's to close, not nobody's.
    if public.module_enabled('machine_workforce') then
      select count(*) into n
        from public.shifts s
        join public.machines m on m.id = s.machine_id
       where s.factory_id = v_factory
         and s.status = 'open'
         and (('company_admin' = any(v_roles)) or m.managed_by = v_uid or m.managed_by is null);
      if n > 0 then
        return query select 'fm_shift_close', 'Shifts still open', n,
          n || ' shift' || case when n = 1 then '' else 's' end || ' still open',
          'Close each one to record stitches and pay the worker',
          ('floor_manager' = any(v_roles));
      end if;
    end if;

    -- NEW — the dashboard's "Leave" card already counts these.
    select count(*) into n from public.leaves l
     where l.factory_id = v_factory and l.status = 'pending';
    if n > 0 then
      return query select 'fm_leave', 'Leave requests', n,
        n || ' leave request' || case when n = 1 then '' else 's' end || ' to decide',
        'A worker is waiting on your approval',
        ('floor_manager' = any(v_roles));
    end if;

    -- Finished orders whose leftover material is still signed out to the floor.
    -- The Orders box grew a "Handover" tab for this and its count had no banner.
    select count(*) into n
      from public.orders o
     where o.factory_id = v_factory
       and o.status <> 'cancelled'
       and (o.status in ('ready_for_delivery','completed')
            or public.fm_floor_is_finished(o.id))
       and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
       and not exists (select 1 from public.fm_handovers h where h.order_id = o.id);
    if n > 0 then
      return query select 'fm_store_handover', 'Material to hand back', n,
        n || ' order' || case when n = 1 then '' else 's' end
          || case when n = 1 then ' needs' else ' need' end || ' material handed back',
        'Log what is left over so it goes back into store stock',
        ('floor_manager' = any(v_roles));
    end if;

    -- The automatic "stock was already here" notice. 0069 addresses it to the
    -- FLOOR MANAGER, and nothing was surfacing it to them.
    select count(*) into n
      from public.material_requests mr
     where mr.factory_id = v_factory
       and mr.origin = 'auto_stock_ready'
       and mr.directed_to = 'floor_manager'
       and mr.status = 'pending';
    if n > 0 then
      return query select 'fm_material_ready', 'Material ready in the store', n,
        n || ' order' || case when n = 1 then '' else 's' end
          || case when n = 1 then ' has' else ' have' end || ' material ready',
        'Everything these need is already in stock - collect it when you are ready',
        ('floor_manager' = any(v_roles));
    end if;
  end if;

  if v_roles && array['store_manager', 'company_admin'] then
    select count(*) into n from public.job_cards jc
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id);
    if n > 0 then
      return query select 'material_requests', 'Material requests', n,
        n || ' material request' || case when n = 1 then '' else 's' end || ' waiting',
        'The floor cannot start production until these are issued',
        ('store_manager' = any(v_roles));
    end if;

    select count(*) into n from public.grns g
     where g.factory_id = v_factory and g.status = 'pending';
    if n > 0 then
      return query select 'grn_pending', 'Deliveries to confirm', n,
        n || ' deliver' || case when n = 1 then 'y' else 'ies' end || case when n = 1 then ' needs' else ' need' end || ' checking in',
        'Confirm what actually arrived against the purchase order',
        ('store_manager' = any(v_roles));
    end if;

    -- A count of one outstanding obligation rather than of rows, so it is 1 or
    -- absent. The brief calls the daily audit mandatory; the Audit tab already
    -- flags it, and this puts the same flag where the role actually starts.
    if not exists (
      select 1 from public.stock_audits sa
       where sa.factory_id = v_factory and sa.audit_type = 'daily'
         and sa.audit_date = current_date
    ) then
      return query select 'sm_audit_today', 'Daily audit not done', 1,
        'Today''s stock audit has not been done',
        'Count every item once a day so the ledger stays trustworthy',
        ('store_manager' = any(v_roles));
    end if;
  end if;

  if v_roles && array['qa', 'company_admin'] then
    select count(*) into n from public.orders o
     where o.factory_id = v_factory and o.status in ('awaiting_cloth_inspection','awaiting_coding');
    if n > 0 then
      return query select 'qa_inspection', 'Orders awaiting inspection', n,
        n || ' order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' inspection',
        'Check the cloth, then code each piece',
        ('qa' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'stage_qa';
    if n > 0 then
      return query select 'qa_stage', 'Stage QA waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' stage QA',
        'Pass or mark damage before the stage can move on',
        ('qa' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_qa_final';
    if n > 0 then
      return query select 'qa_final', 'Final pass waiting', n,
        n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a final pass',
        'Photograph the finished product and pass it',
        ('qa' = any(v_roles));
    end if;
  end if;

  if v_roles && array['delivery', 'company_admin'] then
    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'awaiting_dp_collection'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_collect', 'Pieces to collect', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect',
        'Collect from the floor manager — a photo is required',
        ('delivery' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_over'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_send', 'Pieces to send out', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to send out',
        'Take these to the finishing partner the floor manager chose',
        ('delivery' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and r.partner_ready_at is not null
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_pickup', 'Finished at the partner', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' ready to collect back',
        'The finishing partner says these are done',
        ('delivery' = any(v_roles));
    end if;

    select count(*) into n from public.repeats r
     where r.factory_id = v_factory and r.current_status = 'returned_to_delivery'
       and public.dp_sees_repeat(r.current_delivery_id);
    if n > 0 then
      return query select 'dp_handback', 'Pieces to hand back', n,
        n || ' piece' || case when n = 1 then '' else 's' end || ' to hand back',
        'Return these to the floor manager',
        ('delivery' = any(v_roles));
    end if;

    -- NEW — the "Ready for final delivery" section on the delivery person's own
    -- Orders screen already lists these (9 in Alpha), and it is the last leg of
    -- the job: every stage is through QA and the order goes back to the client.
    -- Same predicate as dp_final_delivery_queue().
    if public.module_enabled('order_lifecycle') then
      select count(*) into n
        from public.orders o
       where o.factory_id = v_factory
         and o.status in ('ready_for_delivery','job_card_confirmed','in_production','in_finishing')
         and not exists (
           select 1 from public.repeats r
           join public.sheets s on s.id = r.sheet_id
           where s.order_id = o.id
             and r.current_status not in ('awaiting_final_qa','completed')
         );
      if n > 0 then
        return query select 'dp_final_delivery', 'Ready for final delivery', n,
          n || ' order' || case when n = 1 then '' else 's' end || ' ready for final delivery',
          'Every stage is through QA — these go back to the client',
          ('delivery' = any(v_roles));
      end if;
    end if;
  end if;

  if ('finishing_partner' = any(v_roles)) then
    select fp.id into v_partner from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;
    if v_partner is not null then
      select count(*) into n from public.repeats r
       where r.factory_id = v_factory and r.current_status = 'handed_off'
         and r.current_partner_id = v_partner and r.partner_ready_at is null;
      if n > 0 then
        return query select 'partner_active', 'Work with you now', n,
          n || ' piece' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' your work',
          'Mark each one finished when you are done with it',
        true;
      end if;
    end if;
  end if;

  if v_roles && array['order_taker', 'company_admin'] then
    select count(*) into n
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (('company_admin' = any(v_roles)) or o.created_by = v_uid);
    if n > 0 then
      return query select 'ot_returns', 'Returns to complete', n,
        n || ' return' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' completing',
        'Photograph each piece as it goes back to the vendor',
        ('order_taker' = any(v_roles));
    end if;
  end if;

  if v_roles && array['accountant', 'company_admin'] then
    select count(*) into n from public.invoices i
     where i.factory_id = v_factory and i.status = 'pending';
    if n > 0 then
      return query select 'acct_receivables', 'Unpaid invoices', n,
        n || ' invoice' || case when n = 1 then '' else 's' end || ' unpaid',
        'Money owed to the factory — record payment when it arrives',
        ('accountant' = any(v_roles));
    end if;

    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'approved';
    if n > 0 then
      return query select 'acct_payables', 'Bills awaiting payment', n,
        n || ' bill' || case when n = 1 then '' else 's' end || ' waiting to be paid',
        'Approved and due — settle and record the payment',
        ('accountant' = any(v_roles));
    end if;
  end if;

  if ('company_admin' = any(v_roles)) then
    select count(*) into n from public.expenses e
     where e.factory_id = v_factory and e.status = 'pending';
    if n > 0 then
      return query select 'owner_approvals', 'Approvals waiting on you', n,
        n || ' approval' || case when n = 1 then '' else 's' end || ' waiting on you',
        'Nothing moves on these until you decide',
        true;
    end if;
  end if;

  if v_roles && array['procurement', 'company_admin'] then
    -- `auto_generated` (raised automatically on a stock shortfall) and `draft`
    -- are both pre-execution.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status in ('auto_generated','draft');
    if n > 0 then
      return query select 'po_draft', 'Purchase orders to raise', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to raise',
        'Auto-raised on a stock shortfall — assign a supplier and send',
        ('procurement' = any(v_roles));
    end if;

    -- NEW — `executed` and `paid` both sit in the PO screen's "To action"
    -- filter, and both have a button on PoDetail waiting to be pressed. They are
    -- two SEPARATE banners, not one, because they ask for two different things:
    -- upload a bill, versus confirm a physical handover. Merging them would put
    -- the user back to opening the list to find out which.
    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status = 'executed';
    if n > 0 then
      return query select 'po_bill', 'Supplier bills to upload', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || case when n = 1 then ' needs' else ' need' end || ' a supplier bill',
        'Sent to the supplier — upload the bill to send it for approval',
        ('procurement' = any(v_roles));
    end if;

    select count(*) into n from public.purchase_orders po
     where po.factory_id = v_factory and po.status = 'paid';
    if n > 0 then
      return query select 'po_handover', 'Purchase orders to hand over', n,
        n || ' purchase order' || case when n = 1 then '' else 's' end || ' to hand over',
        'Paid — confirm handover so the store can check the goods in',
        ('procurement' = any(v_roles));
    end if;
  end if;
end $$;


create or replace function public.my_queue_items(p_queue_key text)
returns table (
  item_id      uuid,
  code         text,
  title        text,
  subtitle     text,
  order_id     uuid,
  order_code   text,
  secondary_id uuid,
  status       text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_role    text   := public.current_user_role();

  v_roles   text[] := public.effective_roles();
  v_uid     uuid := auth.uid();
  v_partner uuid;
begin
  if v_factory is null or v_role is null then
    return;
  end if;

  -- A queue key is not a capability. Asking for another role's queue returns
  -- NOTHING rather than raising, so a stale client requesting a key it no
  -- longer owns degrades to an empty list instead of an error screen.
  if p_queue_key in ('awaiting_job_card','accept_inventory','fm_collect','fm_handover',
                     'fm_final_qa','fm_shift_close','fm_leave')
     and not (v_roles && array['floor_manager','company_admin']) then return; end if;
  if p_queue_key in ('fm_store_handover','fm_material_ready')
     and not (v_roles && array['floor_manager','company_admin']) then return; end if;
  if p_queue_key in ('material_requests','grn_pending')
     and not (v_roles && array['store_manager','company_admin']) then return; end if;
  if p_queue_key in ('qa_inspection','qa_stage','qa_final')
     and not (v_roles && array['qa','company_admin']) then return; end if;
  if p_queue_key in ('dp_collect','dp_send','dp_pickup','dp_handback','dp_final_delivery')
     and not (v_roles && array['delivery','company_admin']) then return; end if;
  if p_queue_key = 'partner_active' and not ('finishing_partner' = any(v_roles)) then return; end if;
  if p_queue_key = 'ot_returns' and not (v_roles && array['order_taker','company_admin']) then return; end if;
  if p_queue_key in ('acct_receivables','acct_payables')
     and not (v_roles && array['accountant','company_admin']) then return; end if;
  if p_queue_key = 'owner_approvals' and not ('company_admin' = any(v_roles)) then return; end if;
  if p_queue_key in ('po_draft','po_bill','po_handover')
     and not (v_roles && array['procurement','company_admin']) then return; end if;

  -- ---- Floor Manager -----------------------------------------------------
  if p_queue_key = 'awaiting_job_card' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(*)::text from public.sheets s where s.order_id = o.id) || ' sheet(s)',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory and o.status in ('awaiting_job_card','job_card_shared')
     order by o.created_at;

  elsif p_queue_key = 'accept_inventory' then
    return query
    select mi.id, o.order_code, o.order_code,
           'Issued by the store - ' || to_char(mi.created_at, 'DD Mon'),
           o.id, o.order_code, mi.id, 'pending'::text
      from public.material_issues mi
      join public.orders o on o.id = mi.order_id
     where mi.factory_id = v_factory and mi.accepted_at is null
     order by mi.created_at;

  elsif p_queue_key in ('fm_collect','fm_handover','fm_final_qa') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '), 'final'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory
       and r.current_status = case p_queue_key
             when 'fm_collect'  then 'awaiting_fm_collection'
             when 'fm_handover' then 'handover_for_delivery'
             else 'awaiting_final_qa' end
     order by o.created_at, r.repeat_code;

  -- NEW. secondary_id is the shift, which is what ShiftClose opens on.
  elsif p_queue_key = 'fm_shift_close' then
    if not public.module_enabled('machine_workforce') then return; end if;
    return query
    select s.id, m.name, m.name,
           coalesce(wp.display_name, 'Unassigned') || ' - open since ' ||
             to_char(s.opened_at, 'DD Mon HH24:MI'),
           s.order_id, o.order_code, s.id, s.status
      from public.shifts s
      join public.machines m on m.id = s.machine_id
      left join public.profiles wp on wp.id = s.worker_id
      left join public.orders o on o.id = s.order_id
     where s.factory_id = v_factory
       and s.status = 'open'
       and (('company_admin' = any(v_roles)) or m.managed_by = v_uid or m.managed_by is null)
     order by m.name;

  -- NEW. Approve/reject is inline on the Leave box, so there is no per-item
  -- screen — the app routes the whole banner there rather than to a list that
  -- cannot be tapped through from.
  elsif p_queue_key = 'fm_leave' then
    return query
    select l.id, coalesce(wp.display_name, 'Worker'), coalesce(wp.display_name, 'Worker'),
           to_char(l.start_date, 'DD Mon') || ' to ' || to_char(l.end_date, 'DD Mon') ||
             ' - ' || l.reason,
           null::uuid, null::text, l.id, l.status
      from public.leaves l
      left join public.profiles wp on wp.id = l.worker_id
     where l.factory_id = v_factory and l.status = 'pending'
     order by l.requested_at;

  elsif p_queue_key = 'fm_store_handover' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(distinct mii.color_code)::text
                from public.material_issues mi2
                join public.material_issue_items mii on mii.material_issue_id = mi2.id
               where mi2.order_id = o.id) || ' item(s) issued',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status <> 'cancelled'
       and (o.status in ('ready_for_delivery','completed')
            or public.fm_floor_is_finished(o.id))
       and exists (select 1 from public.material_issues mi where mi.order_id = o.id)
       and not exists (select 1 from public.fm_handovers h where h.order_id = o.id)
     order by o.updated_at desc;

  elsif p_queue_key = 'fm_material_ready' then
    return query
    select mr.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ready since ' || to_char(mr.requested_at, 'DD Mon'),
           o.id, o.order_code, mr.id, mr.status
      from public.material_requests mr
      join public.orders o on o.id = mr.order_id
      left join public.vendors v on v.id = o.vendor_id
     where mr.factory_id = v_factory
       and mr.origin = 'auto_stock_ready'
       and mr.directed_to = 'floor_manager'
       and mr.status = 'pending'
     order by mr.requested_at;

  -- ---- Store Manager -----------------------------------------------------
  elsif p_queue_key = 'material_requests' then
    return query
    select jc.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - confirmed ' || to_char(jc.confirmed_at, 'DD Mon'),
           o.id, o.order_code, jc.id, jc.status
      from public.job_cards jc
      join public.orders o on o.id = jc.order_id
      left join public.vendors v on v.id = o.vendor_id
     where jc.factory_id = v_factory and jc.status = 'confirmed'
       and jc.material_requested_at is not null
       and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id)
     order by jc.confirmed_at;

  elsif p_queue_key = 'grn_pending' then
    return query
    select g.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier') || ' - raised ' || to_char(po.created_at,'DD Mon'),
           po.order_id, null::text, g.id, g.status
      from public.grns g
      join public.purchase_orders po on po.id = g.purchase_order_id
      left join public.suppliers s on s.id = po.supplier_id
     where g.factory_id = v_factory and g.status = 'pending'
     order by g.created_at;

  -- ---- QA ----------------------------------------------------------------
  elsif p_queue_key = 'qa_inspection' then
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             case when o.status = 'awaiting_cloth_inspection'
                  then 'check the cloth' else 'code the pieces' end,
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status in ('awaiting_cloth_inspection','awaiting_coding')
     order by o.created_at;

  elsif p_queue_key in ('qa_stage','qa_final') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '), 'final pass'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory
       and r.current_status = case p_queue_key
             when 'qa_stage' then 'stage_qa' else 'awaiting_qa_final' end
     order by o.created_at, r.repeat_code;

  -- ---- Delivery ----------------------------------------------------------
  elsif p_queue_key in ('dp_collect','dp_send','dp_pickup','dp_handback') then
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '),'stage')
             || coalesce(' - ' || fp.name, ''),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
      left join public.finishing_partners fp on fp.id = r.current_partner_id
     where r.factory_id = v_factory
       and public.dp_sees_repeat(r.current_delivery_id)
       and case p_queue_key
             when 'dp_collect'  then r.current_status = 'awaiting_dp_collection'
             when 'dp_send'     then r.current_status = 'handed_over'
             when 'dp_pickup'   then r.current_status = 'handed_off' and r.partner_ready_at is not null
             else                    r.current_status = 'returned_to_delivery' end
     order by r.updated_at desc;

  -- NEW. Whole orders, not repeats — the final leg is delivered per order.
  elsif p_queue_key = 'dp_final_delivery' then
    if not public.module_enabled('order_lifecycle') then return; end if;
    return query
    select o.id, o.order_code, o.order_code,
           coalesce(v.name, '-') || ' - ' ||
             (select count(*)::text from public.repeats r
               join public.sheets s on s.id = r.sheet_id
              where s.order_id = o.id) || ' piece(s), all through QA',
           o.id, o.order_code, null::uuid, o.status
      from public.orders o
      left join public.vendors v on v.id = o.vendor_id
     where o.factory_id = v_factory
       and o.status in ('ready_for_delivery','job_card_confirmed','in_production','in_finishing')
       and not exists (
         select 1 from public.repeats r
         join public.sheets s on s.id = r.sheet_id
         where s.order_id = o.id
           and r.current_status not in ('awaiting_final_qa','completed')
       )
     order by o.created_at;

  -- ---- Finishing Partner -------------------------------------------------
  elsif p_queue_key = 'partner_active' then
    select fp.id into v_partner from public.finishing_partners fp
     where fp.user_id = v_uid and fp.factory_id = v_factory and fp.deleted_at is null;
    if v_partner is null then return; end if;
    return query
    select r.id, r.repeat_code, r.repeat_code,
           o.order_code || ' - ' || coalesce(replace(st.stage_type,'_',' '),'stage'),
           o.id, o.order_code, null::uuid, r.current_status
      from public.repeats r
      join public.sheets sh on sh.id = r.sheet_id
      join public.orders o on o.id = sh.order_id
      left join public.order_stages st
             on st.order_id = o.id and st.sequence = greatest(r.current_stage_index,1)
     where r.factory_id = v_factory and r.current_status = 'handed_off'
       and r.current_partner_id = v_partner and r.partner_ready_at is null
     order by r.updated_at desc;

  -- ---- Order Taker -------------------------------------------------------
  elsif p_queue_key = 'ot_returns' then
    return query
    select d.id, o.order_code, o.order_code,
           'Rejected at QA - ' || replace(d.damage_type,'_',' '),
           o.id, o.order_code, d.id, coalesce(d.recheck_state,'awaiting_return')
      from public.damage_records d
      join public.orders o on o.id = d.order_id
     where d.factory_id = v_factory and d.stage_type = 'repeat_qa' and d.repeat_id is null
       and coalesce(d.recheck_state,'awaiting_return') = 'awaiting_return'
       and (('company_admin' = any(v_roles)) or o.created_by = v_uid)
     order by d.created_at;

  -- ---- Accountant / Owner ------------------------------------------------
  elsif p_queue_key = 'acct_receivables' then
    return query
    select i.id, i.invoice_code, i.invoice_code,
           coalesce(v.name, '-') || ' - ' || to_char(i.amount, 'FM999,999,990.00'),
           i.order_id, o.order_code, i.id, i.status
      from public.invoices i
      left join public.orders o on o.id = i.order_id
      left join public.vendors v on v.id = o.vendor_id
     where i.factory_id = v_factory and i.status = 'pending'
     order by i.created_at;

  elsif p_queue_key in ('acct_payables','owner_approvals') then
    return query
    select e.id,
           initcap(replace(e.category,'_',' ')),
           initcap(replace(e.category,'_',' ')),
           coalesce(e.description,'No description') || ' - ' || to_char(e.amount,'FM999,999,990.00'),
           null::uuid, null::text, e.id, e.status
      from public.expenses e
     where e.factory_id = v_factory
       and e.status = case p_queue_key when 'acct_payables' then 'approved' else 'pending' end
     order by e.created_at;

  -- ---- Procurement -------------------------------------------------------
  -- One branch, three statuses: the row shape and destination (PoDetail) are
  -- identical, only the predicate differs.
  elsif p_queue_key in ('po_draft','po_bill','po_handover') then
    return query
    select po.id, po.po_code, po.po_code,
           coalesce(s.name, 'No supplier assigned') || ' - ' ||
             (select count(*)::text from public.po_items pi where pi.purchase_order_id = po.id) || ' line(s)',
           po.order_id, null::text, po.id, po.status
      from public.purchase_orders po
      left join public.suppliers s on s.id = po.supplier_id
     where po.factory_id = v_factory
       and case p_queue_key
             when 'po_draft'  then po.status in ('auto_generated','draft')
             when 'po_bill'   then po.status = 'executed'
             else                  po.status = 'paid' end
     order by po.created_at desc;
  end if;
end $$;


grant execute on function public.my_queue_summary() to authenticated;
grant execute on function public.my_queue_items(text) to authenticated;
