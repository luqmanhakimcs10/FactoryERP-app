/**
 * Fix: sm_issue_materials failed with a check-constraint error whenever a job
 * card's thread requirement (order_thread_requirements) included a colour
 * whose required_meters rounds to 0 (a sheet listing a colour with 0 stitches
 * — not yet coded). It called log_stock_movement(color, -0, 'issue', ...),
 * and stock_movements_sign_chk requires 'issue' rows to be strictly negative,
 * so the insert was refused (23514) for every such job card.
 *
 * Zero meters means nothing to deduct for that colour, so skip the movement
 * (and the reorder side-effects it could trigger) while still recording the
 * material_issue_items line at 0/0.
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
