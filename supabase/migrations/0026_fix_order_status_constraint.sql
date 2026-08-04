-- =============================================================================
-- Factory ERP — extend orders.status to the full lifecycle.
--
-- LATENT BUG, surfaced by Phase 7's invoice generation:
-- Phase 6 added in_production / in_finishing / awaiting_final_qa /
-- ready_for_delivery / completed to the OrderStatus TypeScript union (and to the
-- status-pill maps), but never extended the CHECK constraint on orders.status,
-- which was still the Phase 3 set. Any attempt to advance an order past
-- job_card_confirmed therefore failed with a constraint violation — which is
-- exactly why every order in the database is still sitting at
-- job_card_confirmed or earlier.
--
-- Repeat-level progression was unaffected (repeats.current_status has its own,
-- correct, constraint), so Phase 6's repeat flows worked; only the order-level
-- rollup was blocked.
-- =============================================================================

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in (
    'draft',
    'awaiting_procurement',
    'awaiting_cloth_inspection',
    'awaiting_coding',
    'awaiting_job_card',
    'job_card_shared',
    'job_card_confirmed',
    'in_production',
    'in_finishing',
    'awaiting_final_qa',
    'ready_for_delivery',
    'completed',
    'cancelled'
  ));

-- ---------------------------------------------------------------------------
-- Invoice generation should follow final QA, not precede it.
--
-- Rewritten to state its precondition explicitly rather than advancing whatever
-- order it is handed: an invoice is a claim that the work is done, so it must
-- not be raisable on an order still in production.
-- ---------------------------------------------------------------------------
create or replace function public.fm_generate_invoice(
  p_order_id uuid,
  p_amount   numeric default null,
  p_note     text default null
)
returns public.invoices
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_factory uuid := public.current_factory_id();
  v_amount  numeric;
  v_inv     public.invoices;
  v_rate    numeric := 0.02;   -- billed per stitch; negotiated rates override
  v_open    int;
begin
  perform public.assert_module('finance_reports');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  if exists (select 1 from public.invoices
              where order_id = p_order_id and status <> 'cancelled') then
    raise exception 'This order already has an invoice.' using errcode = '22023';
  end if;

  -- Every repeat must have cleared final QA. Reads repeat_stage_history's cache
  -- rather than the order status, because the repeat is the tracked unit.
  select count(*) into v_open
    from public.repeats r
    join public.sheets s on s.id = r.sheet_id
   where s.order_id = p_order_id
     and r.current_status <> 'completed';

  if v_open > 0 then
    raise exception
      'Cannot invoice yet: % repeat(s) have not passed final QA.', v_open
      using errcode = '22023';
  end if;

  select coalesce(sum(s.stitch_count::numeric * s.repeats_count), 0) * v_rate
    into v_amount
    from public.sheets s where s.order_id = p_order_id;

  v_amount := coalesce(p_amount, v_amount);

  insert into public.invoices
    (factory_id, order_id, invoice_code, amount, status, issued_by, note)
  values
    (v_factory, p_order_id,
     public.make_code(v_factory, 'INV', public.next_counter(v_factory, 'invoice_seq')),
     v_amount, 'pending', auth.uid(), p_note)
  returning * into v_inv;

  update public.orders set status = 'ready_for_delivery' where id = p_order_id;

  return v_inv;
end $$;

grant execute on function public.fm_generate_invoice(uuid, numeric, text) to authenticated;
