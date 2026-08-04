-- =============================================================================
-- Factory ERP — Floor Manager: "Mark vendor informed".
--
-- Distinct from `fm_share_job_card`'s status flip ('draft' -> 'shared'), which
-- records that the card was put in front of the vendor for confirmation. This
-- records a separate real-world event — the vendor/client has been told the job
-- card is ready — and is idempotent, since "informed again" (a phone call after
-- an earlier message, say) is a legitimate thing to re-record.
-- =============================================================================

alter table public.job_cards
  add column if not exists vendor_informed_at timestamptz;

create or replace function public.fm_mark_vendor_informed(p_order_id uuid)
returns public.job_cards
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

  update public.job_cards
     set vendor_informed_at = now()
   where id = v_card.id
  returning * into v_card;

  return v_card;
end $$;

grant execute on function public.fm_mark_vendor_informed(uuid) to authenticated;
