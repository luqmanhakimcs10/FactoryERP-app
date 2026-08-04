-- =============================================================================
-- Factory ERP — Floor Manager: Job Card Builder design details + line removal.
--
-- Two additions to the Job Card Builder:
--
-- 1. `design_code` / `stitches_per_repeat` are new manual fields captured before
--    the stage sequence (and therefore before a job card necessarily exists —
--    `fm_generate_job_card` only creates the row once `order_stages` exist).
--    `fm_save_job_card_design` upserts the draft `job_cards` row itself so the
--    Builder screen can save these fields first, same as `fm_generate_job_card`
--    already does for its own insert-or-update branch.
--
-- 2. `fm_delete_job_card_line` — the Review step lets the floor manager drop a
--    needle line the auto-generation got wrong (e.g. a colour that shouldn't be
--    on this order). Refuses to drop the last remaining line — a job card with
--    zero lines isn't a job card.
-- =============================================================================

alter table public.job_cards
  add column if not exists design_code text,
  add column if not exists stitches_per_repeat numeric;

create or replace function public.fm_save_job_card_design(
  p_order_id            uuid,
  p_design_code         text,
  p_stitches_per_repeat numeric
)
returns public.job_cards
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_card  public.job_cards;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if coalesce(trim(p_design_code), '') = '' then
    raise exception 'A design code is required.' using errcode = '22023';
  end if;
  if p_stitches_per_repeat is null or p_stitches_per_repeat <= 0 then
    raise exception 'Stitches per repeat must be a positive number.' using errcode = '22023';
  end if;

  select * into v_card from public.job_cards where order_id = p_order_id;

  if not found then
    insert into public.job_cards (factory_id, order_id, status, revision, design_code, stitches_per_repeat)
    values (v_order.factory_id, p_order_id, 'draft', 1, trim(p_design_code), p_stitches_per_repeat)
    returning * into v_card;
  else
    if v_card.status = 'confirmed' then
      raise exception 'This job card is confirmed and its design details are locked.'
        using errcode = '22023';
    end if;
    update public.job_cards
       set design_code = trim(p_design_code),
           stitches_per_repeat = p_stitches_per_repeat
     where id = v_card.id
    returning * into v_card;
  end if;

  return v_card;
end $$;

grant execute on function public.fm_save_job_card_design(uuid, text, numeric) to authenticated;

create or replace function public.fm_delete_job_card_line(
  p_job_card_id uuid,
  p_line_id     uuid
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_card    public.job_cards;
  v_count   int;
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

  if not exists (select 1 from public.job_card_lines where id = p_line_id and job_card_id = p_job_card_id) then
    perform public.raise_not_found('Job card line not found.');
  end if;

  select count(*) into v_count from public.job_card_lines where job_card_id = p_job_card_id;
  if v_count <= 1 then
    raise exception 'A job card needs at least one needle line.' using errcode = '22023';
  end if;

  delete from public.job_card_lines where id = p_line_id and job_card_id = p_job_card_id;
end $$;

grant execute on function public.fm_delete_job_card_line(uuid, uuid) to authenticated;
