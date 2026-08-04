-- =============================================================================
-- Factory ERP — Job card: add needle lines one at a time, no gaps.
--
-- The Review screen previously offered every needle line a 1..6 picker, so the
-- Floor Manager chose a needle number that was already implied by the line's
-- position. Two consequences: the screen repeated a six-button bank per line,
-- and a delete could leave "Needle 1" and "Needle 3" with no "Needle 2" —
-- a mapping no physical setup matches.
--
-- This migration moves needle numbering server-side and makes it positional:
--
--   1. `fm_add_job_card_line` — append ONE line. The needle number is assigned
--      here (max + 1), never passed in, and the 6-needle cap of 0037 is
--      enforced on this path too. This is what "+ Add needle" calls.
--   2. `fm_delete_job_card_line` — same signature as 0048, body changed: after
--      the delete the remaining lines are renumbered 1..n so numbering never
--      has a hole. Because the signature is unchanged, `check:migrations`
--      CANNOT tell this version from 0048's — `npm run walk:lifecycle` proves
--      the renumbering is live.
--
-- Renumbering is safe precisely because job_card_lines is only mutable while
-- the card is unconfirmed (both RPCs refuse otherwise, as 0037/0048 do): the
-- mapping has not yet been handed to the floor, so needle N means "the Nth
-- colour on this card", not "the thread currently on machine needle N".
--
-- The renumber runs ASCENDING in a loop rather than as one set-based UPDATE.
-- `job_card_lines` has a plain (non-deferrable) unique (job_card_id,
-- needle_number), so a bulk renumber can trip the constraint mid-statement even
-- when the end state is unique. Ascending, each row moves DOWN into a slot the
-- previous iteration (or the delete) already vacated, so no collision exists at
-- any point.
-- =============================================================================

/**
 * Append one needle line, numbered by position. Refuses once six lines exist —
 * the same cap fm_generate_job_card and fm_update_job_card_line enforce.
 */
create or replace function public.fm_add_job_card_line(
  p_job_card_id       uuid,
  p_thread_color_code text
)
returns public.job_card_lines
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_card    public.job_cards;
  v_count   int;
  v_next    int;
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

  if coalesce(trim(p_thread_color_code), '') = '' then
    raise exception 'A thread colour is required.' using errcode = '22023';
  end if;

  select count(*), coalesce(max(needle_number), 0) + 1
    into v_count, v_next
    from public.job_card_lines
   where job_card_id = p_job_card_id;

  if v_count >= 6 then
    raise exception 'Needle numbers are capped at 6 — this job card already has six lines.'
      using errcode = '22023';
  end if;

  -- max+1 can exceed 6 only if the card was left with a hole by an older
  -- delete (pre-0053). Fall back to the smallest free slot so the cap and the
  -- unique constraint agree with each other.
  if v_next > 6 then
    select min(n) into v_next
      from generate_series(1, 6) as g(n)
     where not exists (
       select 1 from public.job_card_lines
        where job_card_id = p_job_card_id and needle_number = g.n
     );
  end if;

  insert into public.job_card_lines
    (factory_id, job_card_id, sheet_id, needle_number, thread_color_code, stitch_count)
  values
    (v_factory, p_job_card_id, null, v_next, trim(p_thread_color_code), null)
  returning * into v_line;

  return v_line;
end $$;

grant execute on function public.fm_add_job_card_line(uuid, text) to authenticated;

/**
 * Drop a needle line, then close the gap it left. Still refuses to drop the
 * last remaining line — a job card with zero lines isn't a job card.
 */
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
  v_seq     int := 0;
  r         record;
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

  -- Close the hole. Ascending only — see the header for why this cannot be a
  -- single set-based UPDATE.
  for r in
    select id, needle_number
      from public.job_card_lines
     where job_card_id = p_job_card_id
     order by needle_number
  loop
    v_seq := v_seq + 1;
    if r.needle_number <> v_seq then
      update public.job_card_lines set needle_number = v_seq where id = r.id;
    end if;
  end loop;
end $$;

grant execute on function public.fm_delete_job_card_line(uuid, uuid) to authenticated;
