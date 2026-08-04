-- =============================================================================
-- Factory ERP — Floor Manager: photo required to accept inventory.
--
-- `fm_accept_inventory` (0035) was a one-tap action. This adds a photo of the
-- received materials as evidence, mirroring the same "no photo, no state
-- transition" rule every other money/goods-movement RPC in this app already
-- enforces (repeat QA, collection QA, GRN confirmation, ...).
-- =============================================================================

alter table public.material_issues
  add column if not exists accepted_photo_url text;

-- The parameter list is changing (uuid) -> (uuid, text); without an explicit
-- drop, Postgres would keep the old one-argument overload alive alongside the
-- new one, letting a stale client bypass the photo requirement entirely.
drop function if exists public.fm_accept_inventory(uuid);

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

  return v_issue;
end $$;

grant execute on function public.fm_accept_inventory(uuid, text) to authenticated;
