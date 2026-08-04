-- =============================================================================
-- Factory ERP — Phase 4 transition functions.
--
-- `log_stock_movement()` is the ONLY way thread_stock changes. It updates the
-- balance and appends the ledger row together, so a stock change can never exist
-- without its movement — which is exactly what Phase 7's leakage report needs,
-- and what cannot be reconstructed after the fact if it's missed.
--
-- SECURITY: SECURITY DEFINER bypasses RLS, so every function re-checks factory
-- ownership explicitly. Skipping that is a cross-tenant hole.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Codes
-- ---------------------------------------------------------------------------
alter table public.factory_counters
  add column if not exists grn_seq   bigint not null default 0,
  add column if not exists issue_seq bigint not null default 0,
  add column if not exists audit_seq bigint not null default 0;

create or replace function public.next_counter(p_factory_id uuid, p_column text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.factory_counters (factory_id) values (p_factory_id)
  on conflict (factory_id) do nothing;

  execute format(
    'update public.factory_counters set %I = %I + 1 where factory_id = $1 returning %I',
    p_column, p_column, p_column)
  into n using p_factory_id;

  return n;
end $$;

create or replace function public.make_code(p_factory_id uuid, p_prefix text, p_seq bigint)
returns text
language sql stable security definer set search_path = public as $$
  select p_prefix || '-' || (select code_prefix from public.factories where id = p_factory_id)
         || '-' || lpad(p_seq::text, 5, '0')
$$;

-- ---------------------------------------------------------------------------
-- THE ledger primitive
-- ---------------------------------------------------------------------------
/**
 * Apply a signed quantity to a colour's stock and record the movement.
 *
 * Creates the thread_stock row on first sight of a colour, so a GRN for a colour
 * never stocked before works without a separate setup step.
 *
 * Returns the resulting balance.
 */
create or replace function public.log_stock_movement(
  p_color_code    text,
  p_quantity      numeric,      -- signed
  p_movement_type text,
  p_ref_type      text default null,
  p_ref_id        uuid default null,
  p_note          text default null
)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_stock   public.thread_stock;
  v_balance numeric(14,2);
begin
  if v_factory is null then
    raise exception 'Your profile has no factory.' using errcode = '42501';
  end if;
  if coalesce(trim(p_color_code), '') = '' then
    raise exception 'A colour code is required.' using errcode = '22023';
  end if;

  select * into v_stock
    from public.thread_stock
   where factory_id = v_factory and color_code = p_color_code
   for update;

  if not found then
    insert into public.thread_stock (factory_id, color_code, quantity_meters)
    values (v_factory, p_color_code, 0)
    returning * into v_stock;
  end if;

  v_balance := v_stock.quantity_meters + p_quantity;

  -- Stock cannot go negative: issuing more than is held means the count is
  -- wrong, and silently going negative would corrupt the leakage report.
  if v_balance < 0 then
    raise exception 'Not enough % in stock: % m available, % m requested.',
      p_color_code, v_stock.quantity_meters, abs(p_quantity)
      using errcode = '22023';
  end if;

  update public.thread_stock
     set quantity_meters = v_balance, updated_at = now()
   where id = v_stock.id;

  insert into public.stock_movements
    (factory_id, thread_stock_id, color_code, movement_type, quantity_meters,
     balance_after, actor_user_id, ref_type, ref_id, note)
  values
    (v_factory, v_stock.id, p_color_code, p_movement_type, p_quantity,
     v_balance, auth.uid(), p_ref_type, p_ref_id, p_note);

  return v_balance;
end $$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------
create or replace function public.assert_my_po(p_po_id uuid)
returns public.purchase_orders
language plpgsql stable security definer set search_path = public as $$
declare po public.purchase_orders;
begin
  select * into po from public.purchase_orders where id = p_po_id;
  if not found or po.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Purchase order not found.');
  end if;
  return po;
end $$;

create or replace function public.assert_my_grn(p_grn_id uuid)
returns public.grns
language plpgsql stable security definer set search_path = public as $$
declare g public.grns;
begin
  select * into g from public.grns where id = p_grn_id;
  if not found or g.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('GRN not found.');
  end if;
  return g;
end $$;

-- ===========================================================================
-- PROCUREMENT
-- ===========================================================================

/**
 * Manually raise a PO (buffer stock, replacements, seasonal buys).
 * Phase 3's shortfall logic covers order-driven POs; this covers everything else.
 *
 * p_items: [{ "color_code":"RED-01", "quantity_meters":5000, "description":null }, ...]
 */
create or replace function public.po_create_manual(
  p_supplier_id uuid,
  p_items       jsonb,
  p_notes       text default null
)
returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_po      public.purchase_orders;
  it        jsonb;
  n         int := 0;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['procurement','company_admin']);

  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers
     where id = p_supplier_id and factory_id = v_factory and deleted_at is null
  ) then
    raise exception 'Supplier not found in your factory.' using errcode = 'P0002';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A purchase order needs at least one line.' using errcode = '22023';
  end if;

  insert into public.purchase_orders
    (factory_id, po_code, supplier_id, status, auto_created, notes)
  values
    (v_factory,
     public.make_code(v_factory, 'PO', public.next_po_number(v_factory)),
     p_supplier_id, 'draft', false, p_notes)
  returning * into v_po;

  for it in select * from jsonb_array_elements(p_items)
  loop
    n := n + 1;
    if coalesce((it->>'quantity_meters')::numeric, 0) <= 0 then
      raise exception 'Line %: quantity must be greater than zero.', n using errcode = '22023';
    end if;
    if coalesce(trim(it->>'color_code'), '') = ''
       and coalesce(trim(it->>'description'), '') = '' then
      raise exception 'Line %: needs a colour code or a description.', n using errcode = '22023';
    end if;

    insert into public.po_items
      (factory_id, purchase_order_id, color_code, description, quantity_meters)
    values
      (v_factory, v_po.id,
       nullif(trim(it->>'color_code'), ''),
       nullif(trim(it->>'description'), ''),
       (it->>'quantity_meters')::numeric);
  end loop;

  return v_po;
end $$;

/** Procurement has placed the order with the supplier. */
create or replace function public.po_execute(p_po_id uuid)
returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare po public.purchase_orders;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['procurement','company_admin']);
  po := public.assert_my_po(p_po_id);

  if po.status not in ('auto_generated','draft') then
    raise exception 'This PO has already been executed (status: %).', po.status
      using errcode = '22023';
  end if;

  update public.purchase_orders
     set status = 'executed', executed_at = now(), executed_by = auth.uid()
   where id = p_po_id
  returning * into po;

  return po;
end $$;

/** Attach the supplier bill; the PO now waits on the owner (Phase 7 UI). */
create or replace function public.po_upload_bill(
  p_po_id    uuid,
  p_bill_url text,
  p_amount   numeric default null
)
returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare po public.purchase_orders;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['procurement','company_admin']);
  po := public.assert_my_po(p_po_id);

  if po.status not in ('executed','awaiting_approval') then
    raise exception 'Execute the PO with the supplier before uploading a bill (status: %).', po.status
      using errcode = '22023';
  end if;
  if coalesce(trim(p_bill_url), '') = '' then
    raise exception 'A bill file is required.' using errcode = '22023';
  end if;

  update public.purchase_orders
     set bill_url = p_bill_url,
         amount = coalesce(p_amount, amount),
         status = 'awaiting_approval'
   where id = p_po_id
  returning * into po;

  return po;
end $$;

/**
 * Owner approves the expense.
 *
 * NOTE: exposed as an RPC only — the Approvals Inbox screen is Phase 7. It lives
 * here because without it the PO can never reach handover, and the whole
 * procurement walk would be untestable until Phase 7. Phase 7 wires a UI to this
 * same function rather than reimplementing the transition.
 */
create or replace function public.po_owner_approve(p_po_id uuid, p_approve boolean default true)
returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare po public.purchase_orders;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['company_admin']);
  po := public.assert_my_po(p_po_id);

  if po.status <> 'awaiting_approval' then
    raise exception 'This PO is not awaiting approval (status: %).', po.status
      using errcode = '22023';
  end if;

  update public.purchase_orders
     set status = case when p_approve then 'approved' else 'cancelled' end,
         approved_at = now(), approved_by = auth.uid()
   where id = p_po_id
  returning * into po;

  return po;
end $$;

/**
 * Accountant records payment. RPC only for the same reason as approval —
 * Phase 7's Ledgers Home builds the screen on top of this.
 */
create or replace function public.po_record_payment(p_po_id uuid, p_amount numeric default null)
returns public.purchase_orders
language plpgsql security definer set search_path = public as $$
declare po public.purchase_orders;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['accountant','company_admin']);
  po := public.assert_my_po(p_po_id);

  if po.status <> 'approved' then
    raise exception 'This PO has not been approved yet (status: %).', po.status
      using errcode = '22023';
  end if;

  update public.purchase_orders
     set status = 'paid', paid_at = now(), paid_by = auth.uid(),
         amount = coalesce(p_amount, amount)
   where id = p_po_id
  returning * into po;

  return po;
end $$;

/**
 * Procurement hands the goods to the store manager. Creates the GRN (with its
 * lines copied from the PO) that lands in the Store Manager's GRN queue.
 * No stock moves here — stock only changes when the store manager confirms
 * receipt, because until then nobody has counted it.
 */
create or replace function public.po_handover_to_store(p_po_id uuid, p_note text default null)
returns public.grns
language plpgsql security definer set search_path = public as $$
declare
  po      public.purchase_orders;
  v_grn   public.grns;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['procurement','company_admin']);
  po := public.assert_my_po(p_po_id);

  if po.status <> 'paid' then
    raise exception 'Goods can only be handed over once the PO is paid (status: %).', po.status
      using errcode = '22023';
  end if;
  if exists (select 1 from public.grns where purchase_order_id = p_po_id and status <> 'rejected') then
    raise exception 'This PO has already been handed over.' using errcode = '22023';
  end if;

  insert into public.grns
    (factory_id, grn_code, purchase_order_id, status, handed_over_by, note)
  values
    (po.factory_id,
     public.make_code(po.factory_id, 'GRN', public.next_counter(po.factory_id, 'grn_seq')),
     p_po_id, 'pending', auth.uid(), p_note)
  returning * into v_grn;

  -- Expected == ordered; the store manager may reduce received on a short delivery.
  insert into public.grn_items
    (factory_id, grn_id, color_code, description, expected_meters, received_meters)
  select po.factory_id, v_grn.id, i.color_code, i.description,
         i.quantity_meters, i.quantity_meters
  from public.po_items i
  where i.purchase_order_id = p_po_id;

  update public.purchase_orders set status = 'handed_over' where id = p_po_id;

  return v_grn;
end $$;

-- ===========================================================================
-- STORE MANAGER
-- ===========================================================================

/**
 * One-time opening stock entry.
 *
 * Gated on factories.opening_stock_completed_at rather than "is thread_stock
 * empty": emptiness is not a safe test, because a factory could delete rows years
 * later and silently re-open this, overwriting real counts.
 *
 * p_items: [{ "color_code":"RED-01", "quantity_meters":250000 }, ...]
 */
create or replace function public.sm_opening_stock(p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_done    timestamptz;
  it        jsonb;
  n         int := 0;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);

  select opening_stock_completed_at into v_done from public.factories where id = v_factory;
  if v_done is not null then
    raise exception 'Opening stock was already recorded for this factory on %. It cannot be run again.',
      to_char(v_done, 'DD Mon YYYY')
      using errcode = '22023';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Enter at least one colour.' using errcode = '22023';
  end if;

  for it in select * from jsonb_array_elements(p_items)
  loop
    n := n + 1;
    if coalesce((it->>'quantity_meters')::numeric, -1) < 0 then
      raise exception 'Line %: quantity cannot be negative.', n using errcode = '22023';
    end if;

    -- Goes through the ledger like everything else, so the running sum starts
    -- from a real opening balance instead of nothing.
    perform public.log_stock_movement(
      trim(it->>'color_code'),
      (it->>'quantity_meters')::numeric,
      'opening', 'opening', null, 'Opening stock at deployment'
    );
  end loop;

  update public.factories
     set opening_stock_completed_at = now(), opening_stock_completed_by = auth.uid()
   where id = v_factory;

  return jsonb_build_object('colors', n, 'completed_at', now());
end $$;

/**
 * Store manager confirms physical receipt. Only now does stock rise.
 *
 * p_received: optional [{ "grn_item_id": "...", "received_meters": 4800 }, ...]
 * to record a short delivery; omitted lines receive the expected amount.
 */
create or replace function public.sm_confirm_grn(p_grn_id uuid, p_received jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_grn   public.grns;
  it      jsonb;
  r       record;
  v_lines int := 0;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);
  v_grn := public.assert_my_grn(p_grn_id);

  if v_grn.status <> 'pending' then
    raise exception 'This GRN has already been processed (status: %).', v_grn.status
      using errcode = '22023';
  end if;

  -- Apply any short-delivery corrections first.
  if p_received is not null and jsonb_typeof(p_received) = 'array' then
    for it in select * from jsonb_array_elements(p_received)
    loop
      update public.grn_items
         set received_meters = greatest((it->>'received_meters')::numeric, 0)
       where id = (it->>'grn_item_id')::uuid
         and grn_id = p_grn_id;
    end loop;
  end if;

  for r in
    select * from public.grn_items
     where grn_id = p_grn_id and color_code is not null and received_meters > 0
  loop
    perform public.log_stock_movement(
      r.color_code, r.received_meters, 'grn', 'grn', p_grn_id,
      'Receipt against ' || v_grn.grn_code
    );
    v_lines := v_lines + 1;
  end loop;

  update public.grns
     set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_grn_id;

  if v_grn.purchase_order_id is not null then
    update public.purchase_orders set status = 'received'
     where id = v_grn.purchase_order_id;
  end if;

  return jsonb_build_object('grn_id', p_grn_id, 'lines_received', v_lines, 'status', 'confirmed');
end $$;

/**
 * Issue materials against a confirmed job card.
 *
 * The requirement comes from the same order_thread_requirements() the submit-time
 * inventory check used, so what is issued matches what was checked. Each colour
 * writes an `issue` movement referencing the material issue, which references the
 * job card — that is the traceability the leakage report needs.
 */
create or replace function public.sm_issue_materials(
  p_job_card_id uuid,
  p_note        text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_card    public.job_cards;
  v_issue   public.material_issues;
  r         record;
  v_lines   int := 0;
  v_total   numeric := 0;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);

  select * into v_card from public.job_cards where id = p_job_card_id;
  if not found or v_card.factory_id is distinct from v_factory then
    perform public.raise_not_found('Job card not found.');
  end if;
  if v_card.status <> 'confirmed' then
    raise exception 'Materials can only be issued against a confirmed job card (status: %).', v_card.status
      using errcode = '22023';
  end if;
  if exists (select 1 from public.material_issues where job_card_id = p_job_card_id) then
    raise exception 'Materials have already been issued for this job card.' using errcode = '22023';
  end if;

  insert into public.material_issues
    (factory_id, issue_code, job_card_id, order_id, issued_by, note)
  values
    (v_factory,
     public.make_code(v_factory, 'ISS', public.next_counter(v_factory, 'issue_seq')),
     p_job_card_id, v_card.order_id, auth.uid(), p_note)
  returning * into v_issue;

  for r in select * from public.order_thread_requirements(v_card.order_id)
  loop
    insert into public.material_issue_items
      (factory_id, material_issue_id, color_code, required_meters, issued_meters)
    values (v_factory, v_issue.id, r.color_code, r.required_meters, r.required_meters);

    -- Negative: consumption. Raises if stock is insufficient, which aborts the
    -- whole issue rather than half-deducting.
    perform public.log_stock_movement(
      r.color_code, -r.required_meters, 'issue', 'material_issue', v_issue.id,
      'Issued for job card on order ' ||
        coalesce((select order_code from public.orders where id = v_card.order_id), '?')
    );

    v_lines := v_lines + 1;
    v_total := v_total + r.required_meters;
  end loop;

  if v_lines = 0 then
    raise exception 'This job card has no thread requirement to issue.' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'material_issue_id', v_issue.id,
    'issue_code', v_issue.issue_code,
    'lines', v_lines,
    'total_meters', v_total
  );
end $$;

/**
 * Weekly physical audit. Sets each counted colour to its actual figure and
 * records the signed variance as an audit_variance movement — the leakage signal.
 *
 * p_items: [{ "color_code":"RED-01", "actual_meters":248000 }, ...]
 */
create or replace function public.sm_submit_audit(p_items jsonb, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_factory  uuid := public.current_factory_id();
  v_audit    public.stock_audits;
  it         jsonb;
  v_expected numeric;
  v_actual   numeric;
  v_var      numeric;
  v_color    text;
  v_lines    int := 0;
  v_varied   int := 0;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['store_manager','company_admin']);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Count at least one colour.' using errcode = '22023';
  end if;

  insert into public.stock_audits (factory_id, audit_code, conducted_by, note)
  values (v_factory,
          public.make_code(v_factory, 'AUD', public.next_counter(v_factory, 'audit_seq')),
          auth.uid(), p_note)
  returning * into v_audit;

  for it in select * from jsonb_array_elements(p_items)
  loop
    v_color := trim(it->>'color_code');
    v_actual := (it->>'actual_meters')::numeric;
    if v_actual is null or v_actual < 0 then
      raise exception 'Colour %: enter a counted quantity of zero or more.', v_color
        using errcode = '22023';
    end if;

    select coalesce(quantity_meters, 0) into v_expected
      from public.thread_stock
     where factory_id = v_factory and color_code = v_color;
    v_expected := coalesce(v_expected, 0);

    v_var := v_actual - v_expected;

    insert into public.stock_audit_items
      (factory_id, stock_audit_id, color_code, expected_meters, actual_meters, variance_meters)
    values (v_factory, v_audit.id, v_color, v_expected, v_actual, v_var);

    -- Only a real difference moves stock; a matching count still gets its audit
    -- line above, so the sheet records everything that was counted.
    if v_var <> 0 then
      perform public.log_stock_movement(
        v_color, v_var, 'audit_variance', 'stock_audit', v_audit.id,
        'Audit ' || v_audit.audit_code || ': counted ' || v_actual || ' vs expected ' || v_expected
      );
      v_varied := v_varied + 1;
    end if;

    v_lines := v_lines + 1;
  end loop;

  return jsonb_build_object(
    'stock_audit_id', v_audit.id,
    'audit_code', v_audit.audit_code,
    'colors_counted', v_lines,
    'variances', v_varied
  );
end $$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

/** Job cards confirmed but not yet issued — the Material Issue Queue. */
create or replace function public.material_issue_queue()
returns table (
  job_card_id uuid,
  order_id    uuid,
  order_code  text,
  vendor_name text,
  confirmed_at timestamptz,
  colors      int,
  total_meters numeric
)
language sql stable security definer set search_path = public as $$
  select jc.id, o.id, o.order_code, v.name, jc.confirmed_at,
         (select count(*)::int from public.order_thread_requirements(o.id)),
         (select coalesce(sum(required_meters), 0) from public.order_thread_requirements(o.id))
  from public.job_cards jc
  join public.orders o on o.id = jc.order_id
  join public.vendors v on v.id = o.vendor_id
  where jc.factory_id = public.current_factory_id()
    and jc.status = 'confirmed'
    and not exists (select 1 from public.material_issues mi where mi.job_card_id = jc.id)
  order by jc.confirmed_at
$$;

/** Requirement for a job card, with current availability — the Issue Detail. */
create or replace function public.job_card_requirements(p_job_card_id uuid)
returns table (
  color_code      text,
  required_meters numeric,
  available_meters numeric,
  sufficient      boolean
)
language sql stable security definer set search_path = public as $$
  select r.color_code,
         r.required_meters,
         coalesce(ts.quantity_meters, 0),
         coalesce(ts.quantity_meters, 0) >= r.required_meters
  from public.job_cards jc
  join public.order_thread_requirements(jc.order_id) r on true
  left join public.thread_stock ts
         on ts.factory_id = jc.factory_id and ts.color_code = r.color_code
  where jc.id = p_job_card_id
    and jc.factory_id = public.current_factory_id()
  order by r.color_code
$$;

/**
 * Full movement history for one colour, oldest first, with a running balance.
 * This is the trail the DoD requires: type, quantity, actor, timestamp and the
 * event that caused it, for any colour code.
 */
create or replace function public.stock_ledger(p_color_code text)
returns table (
  created_at      timestamptz,
  movement_type   text,
  quantity_meters numeric,
  balance_after   numeric,
  actor           text,
  ref_type        text,
  ref_code        text,
  note            text
)
language sql stable security definer set search_path = public as $$
  select m.created_at,
         m.movement_type,
         m.quantity_meters,
         m.balance_after,
         coalesce(p.display_name, 'system'),
         m.ref_type,
         case m.ref_type
           when 'grn'            then (select grn_code   from public.grns            where id = m.ref_id)
           when 'material_issue' then (select issue_code from public.material_issues  where id = m.ref_id)
           when 'stock_audit'    then (select audit_code from public.stock_audits     where id = m.ref_id)
           else null
         end,
         m.note
  from public.stock_movements m
  left join public.profiles p on p.id = m.actor_user_id
  where m.factory_id = public.current_factory_id()
    and m.color_code = p_color_code
  order by m.created_at, m.id
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.po_create_manual(uuid, jsonb, text) to authenticated;
grant execute on function public.po_execute(uuid) to authenticated;
grant execute on function public.po_upload_bill(uuid, text, numeric) to authenticated;
grant execute on function public.po_owner_approve(uuid, boolean) to authenticated;
grant execute on function public.po_record_payment(uuid, numeric) to authenticated;
grant execute on function public.po_handover_to_store(uuid, text) to authenticated;
grant execute on function public.sm_opening_stock(jsonb) to authenticated;
grant execute on function public.sm_confirm_grn(uuid, jsonb) to authenticated;
grant execute on function public.sm_issue_materials(uuid, text) to authenticated;
grant execute on function public.sm_submit_audit(jsonb, text) to authenticated;
grant execute on function public.material_issue_queue() to authenticated;
grant execute on function public.job_card_requirements(uuid) to authenticated;
grant execute on function public.stock_ledger(text) to authenticated;
grant execute on function public.log_stock_movement(text, numeric, text, text, uuid, text) to authenticated;
