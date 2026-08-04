-- =============================================================================
-- Factory ERP — Initial QA: piece-by-piece Repeat QA.
--
-- Previously `qa_generate_repeats` bulk-coded every repeat on an order in one
-- click, with no per-piece inspection. This adds a piece-level gate in front of
-- that: each physical piece on a sheet must be individually inspected (photo +
-- pass/reject) before the order can move on to the job card.
--
-- No new tables. A sheet's `repeats_count` already defines how many physical
-- pieces it has; this treats each of the 1..repeats_count slots as a "piece"
-- that is either:
--   - PASSED  -> a real `repeats` row is created for it (same code format and
--                `log_repeat_stage('coded', ...)` as the old bulk path), or
--   - REJECTED -> a `damage_records` row is created for it (vendor-accountable,
--                 same as incoming cloth inspection), and no repeat is ever
--                 coded for that slot.
-- A sheet's pieces are "resolved" once (repeats coded) + (rejections logged)
-- reaches repeats_count. An order can advance to the job card once every sheet
-- is resolved.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Pass one piece: code it as the next repeat on its sheet, photo attached.
-- ---------------------------------------------------------------------------
create or replace function public.qa_pass_piece(
  p_order_id  uuid,
  p_sheet_id  uuid,
  p_photo_url text
)
returns public.repeats
language plpgsql security definer set search_path = public as $$
declare
  v_order    public.orders;
  v_sheet    public.sheets;
  v_repeat   public.repeats;
  v_coded    int;
  v_rejected int;
  v_next     int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_photo_url is null or length(trim(p_photo_url)) = 0 then
    raise exception 'A photo is required to pass a piece.' using errcode = '22023';
  end if;

  select * into v_sheet from public.sheets
   where id = p_sheet_id and order_id = p_order_id;
  if not found then
    raise exception 'That sheet does not belong to this order.' using errcode = '22023';
  end if;

  select count(*) into v_coded from public.repeats where sheet_id = p_sheet_id;
  select count(*) into v_rejected from public.damage_records
   where sheet_id = p_sheet_id and repeat_id is null and stage_type = 'repeat_qa';

  if v_coded + v_rejected >= v_sheet.repeats_count then
    raise exception 'Every piece on this sheet has already been inspected.' using errcode = '22023';
  end if;

  v_next := v_coded + 1;

  insert into public.repeats
    (factory_id, sheet_id, repeat_number, repeat_code, current_status)
  values
    (v_order.factory_id, p_sheet_id, v_next,
     v_order.order_code || '-S' || v_sheet.sheet_number || '-R' || lpad(v_next::text, 3, '0'),
     'coded')
  returning * into v_repeat;

  perform public.log_repeat_stage(
    v_repeat.id, 'coded', null, p_photo_url, 'Passed at initial QA'
  );

  return v_repeat;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Reject one piece, or escalate to every unresolved piece on the sheet.
-- ---------------------------------------------------------------------------
create or replace function public.qa_reject_piece(
  p_order_id    uuid,
  p_sheet_id    uuid,
  p_damage_type text,
  p_photo_url   text,
  p_note        text default null,
  p_scope       text default 'piece'
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order    public.orders;
  v_sheet    public.sheets;
  v_coded    int;
  v_rejected int;
  v_remaining int;
  v_count    int;
  i          int;
  v_id       uuid;
  v_ids      uuid[] := '{}';
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;
  if p_scope not in ('piece', 'sheet') then
    raise exception 'Invalid return scope.' using errcode = '22023';
  end if;

  select * into v_sheet from public.sheets
   where id = p_sheet_id and order_id = p_order_id;
  if not found then
    raise exception 'That sheet does not belong to this order.' using errcode = '22023';
  end if;

  select count(*) into v_coded from public.repeats where sheet_id = p_sheet_id;
  select count(*) into v_rejected from public.damage_records
   where sheet_id = p_sheet_id and repeat_id is null and stage_type = 'repeat_qa';
  v_remaining := v_sheet.repeats_count - v_coded - v_rejected;

  if v_remaining <= 0 then
    raise exception 'Every piece on this sheet has already been inspected.' using errcode = '22023';
  end if;

  v_count := case when p_scope = 'sheet' then v_remaining else 1 end;

  for i in 1..v_count loop
    insert into public.damage_records
      (factory_id, order_id, sheet_id, repeat_id, stage_type, damage_type,
       responsible_type, responsible_id, photo_url, note, reported_by)
    values
      (v_order.factory_id, p_order_id, p_sheet_id, null, 'repeat_qa',
       p_damage_type, 'vendor', v_order.vendor_id, p_photo_url, p_note, auth.uid())
    returning id into v_id;
    v_ids := array_append(v_ids, v_id);
  end loop;

  return jsonb_build_object('damage_ids', v_ids, 'count', v_count);
end $$;

-- ---------------------------------------------------------------------------
-- 3. "Continue to job card": every sheet must be fully resolved first.
-- ---------------------------------------------------------------------------
create or replace function public.qa_complete_repeat_qa(p_order_id uuid)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order  public.orders;
  v_sheet  record;
  v_coded    int;
  v_rejected int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['qa','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if v_order.status <> 'awaiting_coding' then
    raise exception 'This order is not awaiting repeat QA (status: %).', v_order.status
      using errcode = '22023';
  end if;

  for v_sheet in select * from public.sheets where order_id = p_order_id loop
    select count(*) into v_coded from public.repeats where sheet_id = v_sheet.id;
    select count(*) into v_rejected from public.damage_records
     where sheet_id = v_sheet.id and repeat_id is null and stage_type = 'repeat_qa';

    if v_coded + v_rejected < v_sheet.repeats_count then
      raise exception 'Sheet % still has pieces awaiting a decision.', v_sheet.sheet_number
        using errcode = '22023';
    end if;
  end loop;

  update public.orders set status = 'awaiting_job_card' where id = p_order_id
  returning * into v_order;

  return v_order;
end $$;

grant execute on function public.qa_pass_piece(uuid, uuid, text) to authenticated;
grant execute on function public.qa_reject_piece(uuid, uuid, text, text, text, text) to authenticated;
grant execute on function public.qa_complete_repeat_qa(uuid) to authenticated;
