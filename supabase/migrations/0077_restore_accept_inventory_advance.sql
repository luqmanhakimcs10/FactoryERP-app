-- =============================================================================
-- Factory ERP — restore two things my own rewrites in 0070/0071 dropped.
--
-- A REGRESSION I INTRODUCED IN 0071
-- ---------------------------------
-- `fm_accept_inventory` has been defined twice before this:
--
--   0040  added the required photo.
--   0041  added the line that matters here — on acceptance the order advances
--         from `job_card_confirmed` to `machine_selection_pending`.
--
-- 0071 needed to add one thing to it (closing the material request). I based
-- that rewrite on 0040's text, which predates 0041, so the status advance
-- silently disappeared. Everything still returned 200: the photo saved, the
-- request closed, and the order simply never left `job_card_confirmed`. Machine
-- assignment, production start and therefore the whole stage loop became
-- unreachable — a dead end with no error anywhere.
--
-- Caught by driving a real order end to end. No unit-level check would have
-- found it: every individual call succeeded. `walk-order-lifecycle` had been
-- reporting it as `order -> machine_selection_pending (is job_card_confirmed)`
-- and I first read that as one of the walk's own pre-existing failures rather
-- than as something I had just broken.
--
-- THE LESSON, WRITTEN DOWN
-- ------------------------
-- Rewriting a function by copying an older migration's body drops every change
-- made between that migration and now. The safe way — used for 0073 and 0076 —
-- is to extract the CURRENT text and inject the one line, rather than retyping
-- from the earliest version that happens to be easy to find.
--
-- This version is 0041's body plus 0071's request-completion, which is what the
-- function should have been all along.
-- =============================================================================

create or replace function public.fm_accept_inventory(
  p_material_issue_id uuid,
  p_photo_url          text
)
returns public.material_issues
language plpgsql security definer set search_path = public as $$
declare
  v_issue public.material_issues;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  if coalesce(trim(p_photo_url), '') = '' then
    raise exception 'A photo of the received materials is required.' using errcode = '22023';
  end if;

  select * into v_issue from public.material_issues where id = p_material_issue_id;
  if not found or v_issue.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Material issue not found.');
  end if;
  if v_issue.accepted_at is not null then
    raise exception 'This material issue has already been accepted.' using errcode = '22023';
  end if;

  update public.material_issues
     set accepted_by = auth.uid(), accepted_at = now(), accepted_photo_url = p_photo_url
   where id = p_material_issue_id
  returning * into v_issue;

  -- 0041's advance, restored. Guarded on the source status so accepting a second
  -- issue on an order already in production cannot drag it backwards.
  update public.orders
     set status = 'machine_selection_pending'
   where id = v_issue.order_id
     and status = 'job_card_confirmed';

  -- 0071's addition: the request is finished once the floor has the material.
  update public.material_requests
     set status = 'completed', completed_at = now()
   where material_issue_id = p_material_issue_id and status <> 'completed';

  return v_issue;
end $$;

grant execute on function public.fm_accept_inventory(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. sm_issue_materials — 0051's zero-requirement guard, restored.
--
-- 0051 exists to fix exactly one thing: a sheet whose thread requirement rounds
-- to 0 must NOT get a stock movement, because `stock_movements` requires an
-- 'issue' row to be strictly negative and a zero would violate the sign
-- constraint and abort the whole issue.
--
-- 0071 rewrote this function from 0013's body, which predates that fix, so the
-- `if r.required_meters > 0` guard vanished. Same mistake as fm_accept_inventory
-- above, same cause: copying the oldest easy-to-find version instead of the
-- current one.
--
-- Below is 0051's body with 0071's two additions layered on. The inline mounting
-- block 0071 added is replaced by a call to `fm_sync_machine_mounts` (0076) —
-- one definition of what "mounted" means, rather than two that can disagree.
-- ---------------------------------------------------------------------------
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
    -- whole issue rather than half-deducting. Skipped when there is nothing to
    -- deduct (required_meters = 0) since 'issue' movements must be < 0.
    if r.required_meters > 0 then
      perform public.log_stock_movement(
        r.color_code, -r.required_meters, 'issue', 'material_issue', v_issue.id,
        'Issued for job card on order ' ||
          coalesce((select order_code from public.orders where id = v_card.order_id), '?')
      );
    end if;

    v_lines := v_lines + 1;
    v_total := v_total + r.required_meters;
  end loop;

  -- Move the request on, so the Requests tab shows a truthful status instead of
  -- leaving every issued request looking permanently outstanding.
  update public.material_requests
     set status = 'issued', material_issue_id = v_issue.id
   where job_card_id = p_job_card_id and status = 'pending';

  -- Mount whatever is now signed out, IF the order already has a machine. It
  -- usually does not at this point (see 0076) — the sync is idempotent and a
  -- no-op without a machine, so calling it here costs nothing and covers the
  -- re-issue case that 0076's assignment-time call cannot.
  perform public.fm_sync_machine_mounts(v_card.order_id);

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

grant execute on function public.sm_issue_materials(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Repair: orders stranded by the 0071 version.
--
-- Any order whose material was accepted while that version was live is sitting
-- at job_card_confirmed with nothing able to move it. Advancing them is exactly
-- what acceptance should have done at the time.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  update public.orders o
     set status = 'machine_selection_pending'
   where o.status = 'job_card_confirmed'
     and exists (
       select 1 from public.material_issues mi
        where mi.order_id = o.id and mi.accepted_at is not null
     );
  get diagnostics n = row_count;
  if n > 0 then
    raise notice 'released % order(s) stranded at job_card_confirmed', n;
  end if;
end $$;
