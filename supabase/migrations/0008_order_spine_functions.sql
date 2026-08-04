-- =============================================================================
-- Factory ERP — Phase 3: order-spine transition functions.
--
-- WHY THESE ARE FUNCTIONS AND NOT CRUD:
-- Each business transition touches several tables and must be atomic. Above all,
-- moving a repeat means (a) appending to repeat_stage_history — the source of
-- truth — and (b) refreshing repeats.current_status, the denormalized cache.
-- Doing that in one place (`log_repeat_stage`) makes drift between them
-- impossible. No client ever writes current_status directly; there is no policy
-- permitting it.
--
-- SECURITY NOTE: these run SECURITY DEFINER, so RLS does NOT protect them from
-- inside. Every function therefore re-checks factory ownership explicitly via
-- assert_my_order(). Skipping that check would be a cross-tenant hole.
-- =============================================================================

-- Pre-repeat lifecycle event: cloth inspection happens before any repeat exists,
-- so it has nowhere in repeat_stage_history to live.
alter table public.orders add column if not exists inspected_at timestamptz;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

create or replace function public.assert_role(p_roles text[])
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_any_role(p_roles) then
    raise exception 'Your role (%) is not permitted to perform this action.',
      coalesce(public.current_user_role(), 'none')
      using errcode = '42501';
  end if;
end $$;

create or replace function public.assert_module(p_module text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.module_enabled(p_module) then
    raise exception 'This feature is not available for your factory.'
      using errcode = '42501';
  end if;
end $$;

/**
 * Fetch an order and prove it belongs to the caller's factory.
 * THE tenant guard for every function below — SECURITY DEFINER bypasses RLS.
 */
create or replace function public.assert_my_order(p_order_id uuid)
returns public.orders
language plpgsql stable security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if o.factory_id is distinct from public.current_factory_id() then
    -- Same message as not-found: never confirm another tenant's row exists.
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  return o;
end $$;

-- ---------------------------------------------------------------------------
-- THE transition primitive.
-- ---------------------------------------------------------------------------
/**
 * Append a stage event for one repeat and refresh its cached status.
 *
 * This is the ONLY sanctioned way to move a repeat. Callers must not insert into
 * repeat_stage_history or update repeats.current_status separately — doing so
 * would desynchronise the cache from the source of truth.
 */
create or replace function public.log_repeat_stage(
  p_repeat_id      uuid,
  p_status         text,
  p_order_stage_id uuid default null,
  p_photo_url      text default null,
  p_note           text default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid;
  v_id      uuid;
begin
  select factory_id into v_factory from public.repeats where id = p_repeat_id;
  if v_factory is null then
    raise exception 'Repeat not found.' using errcode = 'P0002';
  end if;
  if v_factory is distinct from public.current_factory_id() then
    raise exception 'Repeat not found.' using errcode = 'P0002';
  end if;

  -- 1. Source of truth: append-only history.
  insert into public.repeat_stage_history
    (factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note)
  values
    (v_factory, p_repeat_id, p_order_stage_id, p_status, auth.uid(), p_photo_url, p_note)
  returning id into v_id;

  -- 2. Denormalized cache, in the same transaction so it cannot drift.
  update public.repeats
     set current_status = p_status,
         updated_at = now()
   where id = p_repeat_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Codes
-- ---------------------------------------------------------------------------

create or replace function public.next_order_number(p_factory_id uuid)
returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.factory_counters (factory_id) values (p_factory_id)
  on conflict (factory_id) do nothing;

  update public.factory_counters
     set order_seq = order_seq + 1
   where factory_id = p_factory_id
  returning order_seq into n;

  return n;
end $$;

create or replace function public.next_po_number(p_factory_id uuid)
returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.factory_counters (factory_id) values (p_factory_id)
  on conflict (factory_id) do nothing;

  update public.factory_counters
     set po_seq = po_seq + 1
   where factory_id = p_factory_id
  returning po_seq into n;

  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Order capture
-- ---------------------------------------------------------------------------
/**
 * Create a draft order together with all its sheets, atomically.
 *
 * p_sheets shape (array, order preserved as sheet_number):
 *   [{ "color_assignment": "Red base",
 *      "repeats_count": 10,
 *      "thread_color_codes": ["RED-01","GLD-02"],
 *      "stitch_count": 12000 }, ...]
 *
 * repeats_count is stored, not expanded: the actual `repeats` rows come into
 * existence at QA coding (see qa_generate_repeats), because a repeat only exists
 * once the physical cloth has been accepted.
 */
create or replace function public.create_order(
  p_vendor_id        uuid,
  p_sheets           jsonb,
  p_cloth_photos     text[] default '{}',
  p_design_sheet_url text default null
)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_order   public.orders;
  v_num     bigint;
  v_prefix  text;
  s         jsonb;
  i         int := 0;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['company_admin','order_taker']);

  if v_factory is null then
    raise exception 'Your profile has no factory.' using errcode = '42501';
  end if;

  -- Vendor must exist, be live, and belong to this factory.
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and factory_id = v_factory and deleted_at is null
  ) then
    raise exception 'Vendor not found in your factory.' using errcode = 'P0002';
  end if;

  if p_sheets is null or jsonb_typeof(p_sheets) <> 'array' or jsonb_array_length(p_sheets) = 0 then
    raise exception 'An order needs at least one sheet.' using errcode = '22023';
  end if;

  select code_prefix into v_prefix from public.factories where id = v_factory;
  v_num := public.next_order_number(v_factory);

  insert into public.orders
    (factory_id, vendor_id, order_number, order_code, status,
     cloth_photos, design_sheet_url, created_by)
  values
    (v_factory, p_vendor_id, v_num,
     v_prefix || '-' || lpad(v_num::text, 5, '0'), 'draft',
     coalesce(p_cloth_photos, '{}'), p_design_sheet_url, auth.uid())
  returning * into v_order;

  for s in select * from jsonb_array_elements(p_sheets)
  loop
    i := i + 1;

    if coalesce(trim(s->>'color_assignment'), '') = '' then
      raise exception 'Sheet %: colour assignment is required.', i using errcode = '22023';
    end if;
    if coalesce((s->>'repeats_count')::int, 0) <= 0 then
      raise exception 'Sheet %: repeats count must be at least 1.', i using errcode = '22023';
    end if;
    if coalesce((s->>'stitch_count')::int, -1) < 0 then
      raise exception 'Sheet %: stitch count must be zero or more.', i using errcode = '22023';
    end if;

    insert into public.sheets
      (factory_id, order_id, sheet_number, color_assignment,
       repeats_count, thread_color_codes, stitch_count)
    values
      (v_factory, v_order.id, i, trim(s->>'color_assignment'),
       (s->>'repeats_count')::int,
       coalesce(
         (select array_agg(trim(x.v)) from jsonb_array_elements_text(
            case when jsonb_typeof(s->'thread_color_codes') = 'array'
                 then s->'thread_color_codes' else '[]'::jsonb end) as x(v)
          where trim(x.v) <> ''),
         '{}'),
       (s->>'stitch_count')::int);
  end loop;

  return v_order;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Submit: thread consumption + inventory check + auto-PO on shortfall
-- ---------------------------------------------------------------------------
/**
 * Thread requirement per colour for an order.
 *
 * Model (documented assumption, tune in one place):
 *   stitches for a sheet = stitch_count (per repeat) x repeats_count
 *   thread metres        = stitches x METRES_PER_STITCH
 *   a sheet's metres are split evenly across that sheet's thread colours
 *
 * METRES_PER_STITCH = 0.0045 (4.5 mm/stitch) is the common embroidery rule of
 * thumb. Phase 4 can promote it to a per-factory setting; it is isolated here so
 * that change touches nothing else.
 */
create or replace function public.order_thread_requirements(p_order_id uuid)
returns table (color_code text, required_meters numeric)
language sql stable security definer set search_path = public as $$
  with per_sheet as (
    select
      s.id,
      (s.stitch_count::numeric * s.repeats_count) * 0.0045 as meters,
      s.thread_color_codes,
      greatest(coalesce(array_length(s.thread_color_codes, 1), 0), 1) as n_colors
    from public.sheets s
    where s.order_id = p_order_id
  )
  select c.code as color_code, sum(ps.meters / ps.n_colors)::numeric(14,2) as required_meters
  from per_sheet ps
  cross join lateral unnest(ps.thread_color_codes) as c(code)
  group by c.code
$$;

/**
 * Submit a draft order: run the inventory check and branch.
 *   sufficient stock -> 'awaiting_cloth_inspection'
 *   shortfall        -> 'awaiting_procurement' + an auto-generated PO
 *
 * Returns a jsonb summary the UI shows on the review screen.
 */
create or replace function public.submit_order(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order    public.orders;
  v_factory  uuid := public.current_factory_id();
  v_short    jsonb := '[]'::jsonb;
  v_po_id    uuid;
  v_po_code  text;
  v_prefix   text;
  v_num      bigint;
  r          record;
  v_has_short boolean := false;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['company_admin','order_taker']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'draft' then
    raise exception 'This order has already been submitted.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sheets where order_id = p_order_id) then
    raise exception 'An order needs at least one sheet before submission.' using errcode = '22023';
  end if;

  -- Compare requirement against stock, colour by colour.
  for r in
    select req.color_code,
           req.required_meters,
           coalesce(ts.quantity_meters, 0) as available_meters
    from public.order_thread_requirements(p_order_id) req
    left join public.thread_stock ts
           on ts.factory_id = v_factory and ts.color_code = req.color_code
    order by req.color_code
  loop
    if r.required_meters > r.available_meters then
      v_has_short := true;
      v_short := v_short || jsonb_build_object(
        'color_code', r.color_code,
        'required_meters', r.required_meters,
        'available_meters', r.available_meters,
        'shortfall_meters', (r.required_meters - r.available_meters)
      );
    end if;
  end loop;

  if v_has_short then
    -- Auto-PO. Phase 4 builds the execution screens; this only needs the record
    -- so the order can show a read-only "Awaiting Procurement" badge.
    select code_prefix into v_prefix from public.factories where id = v_factory;
    v_num := public.next_po_number(v_factory);
    v_po_code := 'PO-' || v_prefix || '-' || lpad(v_num::text, 5, '0');

    insert into public.purchase_orders
      (factory_id, po_code, order_id, status, auto_created)
    values (v_factory, v_po_code, p_order_id, 'auto_generated', true)
    returning id into v_po_id;

    insert into public.po_items (factory_id, purchase_order_id, color_code, quantity_meters)
    select v_factory, v_po_id, x->>'color_code', (x->>'shortfall_meters')::numeric
    from jsonb_array_elements(v_short) x;

    update public.orders
       set status = 'awaiting_procurement', submitted_at = now()
     where id = p_order_id;
  else
    update public.orders
       set status = 'awaiting_cloth_inspection', submitted_at = now()
     where id = p_order_id;
  end if;

  return jsonb_build_object(
    'order_id', p_order_id,
    'status', case when v_has_short then 'awaiting_procurement' else 'awaiting_cloth_inspection' end,
    'shortfalls', v_short,
    'purchase_order_id', v_po_id,
    'po_code', v_po_code
  );
end $$;

-- ---------------------------------------------------------------------------
-- 3. QA: incoming cloth inspection
-- ---------------------------------------------------------------------------
/**
 * Record a vendor-accountable damage finding against incoming cloth.
 * Pre-repeat, so the record hangs off the order (and optionally a sheet).
 * Does not by itself advance the order — QA may log several findings.
 */
create or replace function public.qa_report_cloth_damage(
  p_order_id    uuid,
  p_damage_type text,
  p_sheet_id    uuid default null,
  p_photo_url   text default null,
  p_note        text default null
)
returns public.damage_records
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_rec   public.damage_records;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status not in ('awaiting_cloth_inspection','awaiting_procurement') then
    raise exception 'This order is not awaiting cloth inspection.' using errcode = '22023';
  end if;
  if p_sheet_id is not null and not exists (
    select 1 from public.sheets where id = p_sheet_id and order_id = p_order_id
  ) then
    raise exception 'That sheet does not belong to this order.' using errcode = '22023';
  end if;

  insert into public.damage_records
    (factory_id, order_id, sheet_id, repeat_id, stage_type, damage_type,
     responsible_type, responsible_id, photo_url, note, reported_by)
  values
    (v_order.factory_id, p_order_id, p_sheet_id, null, 'incoming_inspection',
     p_damage_type, 'vendor', v_order.vendor_id, p_photo_url, p_note, auth.uid())
  returning * into v_rec;

  return v_rec;
end $$;

/** Accept the cloth: inspection done, order moves to coding. */
create or replace function public.qa_accept_cloth(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'awaiting_cloth_inspection' then
    raise exception 'This order is not awaiting cloth inspection (status: %).', v_order.status
      using errcode = '22023';
  end if;

  update public.orders
     set status = 'awaiting_coding', inspected_at = now()
   where id = p_order_id
  returning * into v_order;

  return v_order;
end $$;

-- ---------------------------------------------------------------------------
-- 4. QA: repeat coding — where the atomic tracked unit comes into existence
-- ---------------------------------------------------------------------------
/**
 * Expand every sheet's repeats_count into actual `repeats` rows, each with a
 * unique human-readable code, and log the 'coded' event for each into
 * repeat_stage_history (the source of truth).
 *
 * Code format:  <FACTORY>-<ORDER#>-S<sheet>-R<repeat>   e.g. ALP-00007-S1-R001
 * Globally unique because the prefix embeds the factory.
 *
 * Idempotent: re-running does not duplicate repeats.
 */
create or replace function public.qa_generate_repeats(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_sheet   record;
  v_repeat  public.repeats;
  i         int;
  v_created int := 0;
  v_total   int := 0;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status not in ('awaiting_coding','awaiting_job_card') then
    raise exception 'This order is not ready for repeat coding (status: %).', v_order.status
      using errcode = '22023';
  end if;

  for v_sheet in
    select * from public.sheets where order_id = p_order_id order by sheet_number
  loop
    v_total := v_total + v_sheet.repeats_count;

    for i in 1..v_sheet.repeats_count loop
      -- Skip any repeat that already exists, so the call is safe to retry.
      if exists (
        select 1 from public.repeats
         where sheet_id = v_sheet.id and repeat_number = i
      ) then
        continue;
      end if;

      insert into public.repeats
        (factory_id, sheet_id, repeat_number, repeat_code, current_status)
      values
        (v_order.factory_id, v_sheet.id, i,
         v_order.order_code || '-S' || v_sheet.sheet_number || '-R' || lpad(i::text, 3, '0'),
         'coded')
      returning * into v_repeat;

      -- Source of truth. log_repeat_stage also refreshes current_status.
      perform public.log_repeat_stage(
        v_repeat.id, 'coded', null, null, 'Coded at incoming QA'
      );

      v_created := v_created + 1;
    end loop;
  end loop;

  if v_total = 0 then
    raise exception 'This order has no sheets to code.' using errcode = '22023';
  end if;

  update public.orders set status = 'awaiting_job_card' where id = p_order_id;

  return jsonb_build_object(
    'order_id', p_order_id,
    'repeats_created', v_created,
    'repeats_expected', v_total,
    'status', 'awaiting_job_card'
  );
end $$;

-- ---------------------------------------------------------------------------
-- 5. Floor manager: stage sequence
-- ---------------------------------------------------------------------------
/**
 * Replace the order's finishing stage sequence.
 *
 * p_stages: [{ "stage_type":"embroidery", "is_outsourced":false,
 *              "sla_hours":24, "partner_id":null, "handler_user_id":null }, ...]
 * Array order defines `sequence`.
 *
 * Rewritable while the job card is not yet confirmed — that is what makes the
 * vendor's "changes requested" loop work.
 */
create or replace function public.fm_set_stage_sequence(
  p_order_id uuid,
  p_stages   jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  st      jsonb;
  i       int := 0;
  v_partner uuid;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status not in ('awaiting_job_card','job_card_shared') then
    raise exception 'The stage sequence can only be set before the job card is confirmed (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_stages is null or jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) = 0 then
    raise exception 'Pick at least one stage.' using errcode = '22023';
  end if;

  -- Safe to clear: history rows keep their own copy via ON DELETE SET NULL, so
  -- no repeat's audit trail is lost when the sequence is revised.
  delete from public.order_stages where order_id = p_order_id;

  for st in select * from jsonb_array_elements(p_stages)
  loop
    i := i + 1;
    v_partner := nullif(st->>'partner_id', '')::uuid;

    if v_partner is not null and not exists (
      select 1 from public.finishing_partners
       where id = v_partner and factory_id = v_order.factory_id and deleted_at is null
    ) then
      raise exception 'Stage %: finishing partner not found in your factory.', i using errcode = 'P0002';
    end if;

    insert into public.order_stages
      (factory_id, order_id, stage_type, sequence, is_outsourced,
       sla_hours, handler_user_id, partner_id)
    values
      (v_order.factory_id, p_order_id, st->>'stage_type', i,
       coalesce((st->>'is_outsourced')::boolean, false),
       coalesce((st->>'sla_hours')::int, 24),
       nullif(st->>'handler_user_id', '')::uuid,
       v_partner);
  end loop;

  return jsonb_build_object('order_id', p_order_id, 'stages', i);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Floor manager: job card generation
-- ---------------------------------------------------------------------------
/**
 * Generate (or regenerate) the job card and its needle lines from the sheets and
 * thread colours captured at order capture.
 *
 * One line per DISTINCT thread colour in the order — that mirrors the machine:
 * one needle threaded per colour. Needle numbers are assigned in first-appearance
 * order. Regenerating bumps `revision` so a re-shared card is distinguishable.
 */
create or replace function public.fm_generate_job_card(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_card_id uuid;
  v_rev     int;
  v_lines   int := 0;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status not in ('awaiting_job_card','job_card_shared') then
    raise exception 'A job card can only be generated before confirmation (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.order_stages where order_id = p_order_id) then
    raise exception 'Pick the stage sequence before generating the job card.' using errcode = '22023';
  end if;

  select id, revision into v_card_id, v_rev
    from public.job_cards where order_id = p_order_id;

  if v_card_id is null then
    insert into public.job_cards (factory_id, order_id, status, revision)
    values (v_order.factory_id, p_order_id, 'draft', 1)
    returning id into v_card_id;
  else
    if (select status from public.job_cards where id = v_card_id) = 'confirmed' then
      raise exception 'This job card is already confirmed.' using errcode = '22023';
    end if;
    update public.job_cards
       set status = 'draft', revision = v_rev + 1, change_notes = null, shared_at = null
     where id = v_card_id;
    delete from public.job_card_lines where job_card_id = v_card_id;
  end if;

  -- Distinct colours in first-appearance order -> sequential needle numbers.
  insert into public.job_card_lines
    (factory_id, job_card_id, sheet_id, needle_number, thread_color_code, stitch_count)
  select
    v_order.factory_id,
    v_card_id,
    null,
    row_number() over (order by c.first_sheet, c.color_code),
    c.color_code,
    c.stitches
  from (
    select
      col.code as color_code,
      min(s.sheet_number) as first_sheet,
      sum((s.stitch_count::numeric * s.repeats_count)
          / greatest(coalesce(array_length(s.thread_color_codes,1),0),1))::int as stitches
    from public.sheets s
    cross join lateral unnest(s.thread_color_codes) as col(code)
    where s.order_id = p_order_id
    group by col.code
  ) c;

  select count(*) into v_lines from public.job_card_lines where job_card_id = v_card_id;

  if v_lines = 0 then
    raise exception 'No thread colours were captured on this order, so no needle lines can be generated.'
      using errcode = '22023';
  end if;

  return jsonb_build_object('order_id', p_order_id, 'job_card_id', v_card_id, 'lines', v_lines);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Job card share / changes / confirm
-- ---------------------------------------------------------------------------

create or replace function public.fm_share_job_card(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_card  public.job_cards;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'Generate the job card first.' using errcode = 'P0002';
  end if;
  if v_card.status = 'confirmed' then
    raise exception 'This job card is already confirmed.' using errcode = '22023';
  end if;

  update public.job_cards
     set status = 'shared', shared_at = now(), change_notes = null
   where id = v_card.id;

  update public.orders set status = 'job_card_shared' where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'job_card_status', 'shared');
end $$;

/** Vendor asked for changes: back to draft so the sequence/card can be revised. */
create or replace function public.fm_request_job_card_changes(
  p_order_id uuid,
  p_notes    text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_card  public.job_cards;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'There is no job card on this order.' using errcode = 'P0002';
  end if;
  if v_card.status <> 'shared' then
    raise exception 'Only a shared job card can have changes requested (status: %).', v_card.status
      using errcode = '22023';
  end if;

  update public.job_cards
     set status = 'draft', change_notes = p_notes, shared_at = null
   where id = v_card.id;

  -- Back to the floor manager's queue, which is where the stage picker lives.
  update public.orders set status = 'awaiting_job_card' where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'job_card_status', 'draft',
                            'change_notes', p_notes);
end $$;

/**
 * Vendor confirmed. This is the trigger Phase 4's material-issue queue reads.
 * Also advances every repeat to 'ready_for_production' — via log_repeat_stage,
 * so each transition is recorded in history and not just cached.
 */
create or replace function public.fm_confirm_job_card(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order  public.orders;
  v_card   public.job_cards;
  v_first  uuid;
  r        record;
  v_moved  int := 0;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'There is no job card on this order.' using errcode = 'P0002';
  end if;
  if v_card.status <> 'shared' then
    raise exception 'The job card must be shared with the vendor before confirmation (status: %).', v_card.status
      using errcode = '22023';
  end if;

  update public.job_cards
     set status = 'confirmed', confirmed_at = now(), change_notes = null
   where id = v_card.id;

  update public.orders set status = 'job_card_confirmed' where id = p_order_id;

  -- First stage in the sequence: what the repeats are now queued for.
  select id into v_first from public.order_stages
   where order_id = p_order_id order by sequence limit 1;

  for r in
    select rp.id
      from public.repeats rp
      join public.sheets s on s.id = rp.sheet_id
     where s.order_id = p_order_id
       and rp.current_status in ('coded','awaiting_job_card')
  loop
    perform public.log_repeat_stage(
      r.id, 'ready_for_production', v_first, null, 'Job card confirmed by vendor'
    );
    v_moved := v_moved + 1;
  end loop;

  return jsonb_build_object('order_id', p_order_id, 'job_card_status', 'confirmed',
                            'repeats_advanced', v_moved);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Status tracker, driven by repeat_stage_history
-- ---------------------------------------------------------------------------
/**
 * The order's lifecycle timeline for the stitch-line UI.
 *
 * Repeat-level milestones are derived from repeat_stage_history (the source of
 * truth) — never from a hardcoded step list — and the finishing steps come from
 * the order's own order_stages rows, so an order configured
 * embroidery -> clipping -> press yields exactly those three steps.
 *
 * The one exception is 'inspection', which predates any repeat and therefore has
 * no history row to read; it uses orders.inspected_at.
 *
 * Returns: step_key, label, state ('done'|'current'|'ahead'), at, detail
 */
create or replace function public.order_timeline(p_order_id uuid)
returns table (
  step_key text,
  label    text,
  state    text,
  at       timestamptz,
  detail   text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_order    public.orders;
  v_total    int;
  v_coded_at timestamptz;
  v_coded    int;
  v_card     public.job_cards;
  v_ready_at timestamptz;
  v_ready    int;
  st         record;
  v_seen     int;
  v_reached  boolean := false;
begin
  v_order := public.assert_my_order(p_order_id);

  select coalesce(sum(repeats_count), 0) into v_total
    from public.sheets where order_id = p_order_id;

  -- Coding: straight from history.
  select min(h.created_at), count(distinct h.repeat_id)
    into v_coded_at, v_coded
    from public.repeat_stage_history h
    join public.repeats rp on rp.id = h.repeat_id
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id and h.status = 'coded';

  select * into v_card from public.job_cards where order_id = p_order_id;

  select min(h.created_at), count(distinct h.repeat_id)
    into v_ready_at, v_ready
    from public.repeat_stage_history h
    join public.repeats rp on rp.id = h.repeat_id
    join public.sheets s on s.id = rp.sheet_id
   where s.order_id = p_order_id and h.status = 'ready_for_production';

  -- 1. Captured
  return query select
    'captured', 'Order captured',
    case when v_order.submitted_at is not null then 'done' else 'current' end,
    coalesce(v_order.submitted_at, v_order.created_at),
    v_total || ' repeats across ' ||
      (select count(*) from public.sheets where order_id = p_order_id) || ' sheets';

  -- 2. Procurement (only when the thread check found a shortfall)
  if v_order.status = 'awaiting_procurement'
     or exists (select 1 from public.purchase_orders where order_id = p_order_id) then
    return query select
      'procurement', 'Awaiting procurement',
      case when v_order.status = 'awaiting_procurement' then 'current' else 'done' end,
      (select min(created_at) from public.purchase_orders where order_id = p_order_id),
      (select string_agg(po_code, ', ') from public.purchase_orders where order_id = p_order_id);
  end if;

  -- 3. Inspection (pre-repeat: no history row exists to read)
  return query select
    'inspection', 'Cloth inspection',
    case
      when v_order.inspected_at is not null then 'done'
      when v_order.status = 'awaiting_cloth_inspection' then 'current'
      else 'ahead'
    end,
    v_order.inspected_at,
    (select case when count(*) > 0 then count(*) || ' damage record(s)' else null end
       from public.damage_records
      where order_id = p_order_id and responsible_type = 'vendor');

  -- 4. QA coding — from history
  return query select
    'coding', 'QA repeat coding',
    case
      when coalesce(v_coded, 0) >= v_total and v_total > 0 then 'done'
      when v_order.status = 'awaiting_coding' then 'current'
      when coalesce(v_coded, 0) > 0 then 'current'
      else 'ahead'
    end,
    v_coded_at,
    case when coalesce(v_coded,0) > 0
         then v_coded || ' of ' || v_total || ' repeats coded' else null end;

  -- 5. Job card
  return query select
    'job_card', 'Job card',
    case
      when v_card.status = 'confirmed' then 'done'
      when v_card.status is not null then 'current'
      when v_order.status = 'awaiting_job_card' then 'current'
      else 'ahead'
    end,
    coalesce(v_card.confirmed_at, v_card.shared_at),
    case
      when v_card.status = 'confirmed' then 'Confirmed by vendor'
      when v_card.status = 'shared' then 'Shared, awaiting vendor'
      when v_card.status = 'draft' and v_card.change_notes is not null then 'Changes requested'
      when v_card.status = 'draft' then 'Draft'
      else null
    end;

  -- 6. Production + finishing: one step per configured stage, in sequence.
  for st in
    select os.*, row_number() over (order by os.sequence) as rn
      from public.order_stages os
     where os.order_id = p_order_id
     order by os.sequence
  loop
    -- How many repeats have a history row against this stage?
    select count(distinct h.repeat_id) into v_seen
      from public.repeat_stage_history h
     where h.order_stage_id = st.id;

    return query select
      'stage_' || st.sequence::text,
      initcap(st.stage_type) || case when st.is_outsourced then ' (outsourced)' else '' end,
      case
        when v_total > 0 and v_seen >= v_total and st.sequence = 1 and v_ready >= v_total then 'current'
        when v_seen = 0 then 'ahead'
        else 'current'
      end,
      (select min(created_at) from public.repeat_stage_history where order_stage_id = st.id),
      -- "reached" not "done": a repeat having a history row at this stage means it
      -- has arrived there, which is not the same as the stage being finished.
      -- Production/finishing completion tracking lands in Phases 5-6.
      case when v_seen > 0 then v_seen || ' of ' || v_total || ' repeats reached' else null end;
  end loop;

  -- 7. Delivery — always the tail of the sequence.
  return query select
    'delivery', 'Delivery to vendor', 'ahead'::text, null::timestamptz, null::text;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: RPCs are called by authenticated users; each does its own role check.
-- ---------------------------------------------------------------------------
grant execute on function public.create_order(uuid, jsonb, text[], text) to authenticated;
grant execute on function public.submit_order(uuid) to authenticated;
grant execute on function public.order_thread_requirements(uuid) to authenticated;
grant execute on function public.qa_report_cloth_damage(uuid, text, uuid, text, text) to authenticated;
grant execute on function public.qa_accept_cloth(uuid) to authenticated;
grant execute on function public.qa_generate_repeats(uuid) to authenticated;
grant execute on function public.fm_set_stage_sequence(uuid, jsonb) to authenticated;
grant execute on function public.fm_generate_job_card(uuid) to authenticated;
grant execute on function public.fm_share_job_card(uuid) to authenticated;
grant execute on function public.fm_request_job_card_changes(uuid, text) to authenticated;
grant execute on function public.fm_confirm_job_card(uuid) to authenticated;
grant execute on function public.order_timeline(uuid) to authenticated;
grant execute on function public.log_repeat_stage(uuid, text, uuid, text, text) to authenticated;
