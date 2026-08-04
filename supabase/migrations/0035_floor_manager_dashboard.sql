-- =============================================================================
-- Factory ERP — Floor Manager dashboard: Accept Inventory + Leave approval.
--
-- Two small additions, both additive (no existing table/column touched beyond
-- new nullable columns on material_issues):
--
-- 1. ACCEPT INVENTORY. `material_issues` previously recorded only the store
--    manager's issue event (issued_by/issued_at) — there was no signal that the
--    floor manager had physically received it. `accepted_by`/`accepted_at` add
--    that second event, and `fm_accept_inventory` is the only sanctioned way to
--    set them (never a direct client write, matching every other transition in
--    this schema).
--
-- 2. LEAVE APPROVAL. RLS already lets floor_manager/company_admin read every
--    leave in the factory and UPDATE any row (0022_phase8_dashboard_schema.sql).
--    `fm_decide_leave` exists anyway, for the same reason every other state
--    transition in this app goes through a function rather than a raw client
--    update: it validates the leave is still 'pending' before deciding it (no
--    silent double-decision) and stamps approved_by from auth.uid() server-side
--    rather than trusting whatever the client sends.
-- =============================================================================

alter table public.material_issues
  add column if not exists accepted_by uuid references public.profiles(id) on delete set null,
  add column if not exists accepted_at timestamptz;

-- ---------------------------------------------------------------------------
-- 1. Accept inventory
-- ---------------------------------------------------------------------------

/** Material issues not yet accepted by the floor manager — the pickup queue. */
create or replace function public.fm_material_issue_queue()
returns table (
  material_issue_id uuid,
  order_id           uuid,
  order_code         text,
  vendor_name        text,
  issued_by_name     text,
  issued_at          timestamptz,
  colors             int,
  total_meters       numeric
)
language sql stable security definer set search_path = public as $$
  select mi.id, o.id, o.order_code, v.name,
         coalesce(p.display_name, '—'),
         mi.issued_at,
         (select count(*)::int from public.material_issue_items where material_issue_id = mi.id),
         (select coalesce(sum(issued_meters), 0) from public.material_issue_items where material_issue_id = mi.id)
  from public.material_issues mi
  join public.orders o on o.id = mi.order_id
  join public.vendors v on v.id = o.vendor_id
  left join public.profiles p on p.id = mi.issued_by
  where mi.factory_id = public.current_factory_id()
    and mi.accepted_at is null
  order by mi.issued_at
$$;

create or replace function public.fm_accept_inventory(p_material_issue_id uuid)
returns public.material_issues
language plpgsql security definer set search_path = public as $$
declare
  v_issue public.material_issues;
begin
  perform public.assert_module('inventory_procurement');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  select * into v_issue from public.material_issues where id = p_material_issue_id;
  if not found or v_issue.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Material issue not found.');
  end if;
  if v_issue.accepted_at is not null then
    raise exception 'This material issue has already been accepted.' using errcode = '22023';
  end if;

  update public.material_issues
     set accepted_by = auth.uid(), accepted_at = now()
   where id = p_material_issue_id
  returning * into v_issue;

  return v_issue;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Leave approval
-- ---------------------------------------------------------------------------

create or replace function public.fm_decide_leave(p_leave_id uuid, p_approve boolean)
returns public.leaves
language plpgsql security definer set search_path = public as $$
declare
  v_leave public.leaves;
begin
  perform public.assert_module('machine_workforce');
  perform public.assert_role(array['floor_manager', 'company_admin']);

  select * into v_leave from public.leaves where id = p_leave_id;
  if not found or v_leave.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Leave request not found.');
  end if;
  if v_leave.status <> 'pending' then
    raise exception 'This leave request has already been decided.' using errcode = '22023';
  end if;

  update public.leaves
     set status = case when p_approve then 'approved' else 'rejected' end,
         approved_by = auth.uid(),
         approved_at = now()
   where id = p_leave_id
  returning * into v_leave;

  return v_leave;
end $$;

grant execute on function public.fm_material_issue_queue() to authenticated;
grant execute on function public.fm_accept_inventory(uuid) to authenticated;
grant execute on function public.fm_decide_leave(uuid, boolean) to authenticated;
