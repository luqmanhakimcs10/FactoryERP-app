-- =============================================================================
-- Factory ERP — Floor Manager: editable needle/colour mapping on the job card.
--
-- `fm_generate_job_card` (0008) derives needle lines from the sheets and locks
-- nothing — the Floor Manager could only regenerate from scratch, never correct
-- one line. This adds a per-line edit RPC (locked once the card is confirmed,
-- same as everything else on the card) and enforces the 6-needle cap the spec
-- describes, both on manual edits and at generation time: a job card with more
-- than 6 distinct thread colours cannot be produced as-is and must be hard-fail
-- rather than silently generated, since silently dropping colours would mean
-- production runs short a needle nobody asked to skip.
-- =============================================================================

create or replace function public.fm_update_job_card_line(
  p_job_card_id       uuid,
  p_line_id           uuid,
  p_needle_number     int,
  p_thread_color_code text
)
returns public.job_card_lines
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_card    public.job_cards;
  v_line    public.job_card_lines;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);

  select * into v_card from public.job_cards
   where id = p_job_card_id and factory_id = v_factory;
  if not found then
    perform public.raise_not_found('Job card not found.');
  end if;

  if v_card.status = 'confirmed' then
    raise exception 'This job card is confirmed and its needle mapping is locked.'
      using errcode = '22023';
  end if;

  select * into v_line from public.job_card_lines
   where id = p_line_id and job_card_id = p_job_card_id;
  if not found then
    perform public.raise_not_found('Job card line not found.');
  end if;

  if p_needle_number < 1 or p_needle_number > 6 then
    raise exception 'Needle number must be between 1 and 6.' using errcode = '22023';
  end if;
  if coalesce(trim(p_thread_color_code), '') = '' then
    raise exception 'A thread colour is required.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.job_card_lines
     where job_card_id = p_job_card_id
       and needle_number = p_needle_number
       and id <> p_line_id
  ) then
    raise exception 'Needle % is already assigned to another colour on this job card.', p_needle_number
      using errcode = '22023';
  end if;

  update public.job_card_lines
     set needle_number = p_needle_number,
         thread_color_code = trim(p_thread_color_code)
   where id = p_line_id
  returning * into v_line;

  return v_line;
end $$;

grant execute on function public.fm_update_job_card_line(uuid, uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Same generation logic as 0008, plus the 6-needle cap. A job card with more
-- than 6 distinct colours cannot be generated at all — the order needs to be
-- corrected (or the mapping consolidated) before a job card can exist for it.
-- ---------------------------------------------------------------------------
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
  if v_lines > 6 then
    raise exception 'This order uses % distinct thread colours, but a job card is capped at 6 needles. Consolidate the colours on the order before generating the job card.', v_lines
      using errcode = '22023';
  end if;

  return jsonb_build_object('order_id', p_order_id, 'job_card_id', v_card_id, 'lines', v_lines);
end $$;
