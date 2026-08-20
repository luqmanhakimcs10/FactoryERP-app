-- =============================================================================
-- Factory ERP — the finishing partner's three numbers, on their link.
--
-- WHY THIS EXISTS AT ALL
-- ----------------------
-- Every other role's Key Metrics Grid is assembled from reads their dashboard
-- already makes. The finishing partner is the one exception: 0086 replaced
-- their login with a token link, and `partner_get_earnings_summary` /
-- `partner_get_completed_work` both resolve the partner from `auth.uid()` —
-- which a link has none of. So the two figures the brief asks for are
-- unreachable from the portal without a token-keyed reader.
--
-- This is NOT new logic. The period sum below is the same one
-- `partner_get_earnings_summary` (0022) computes, over the same
-- `partner_ledger` rows, with the same period convention. Only how the partner
-- is identified changes: `partner_by_token` instead of `auth.uid()`, exactly as
-- the other three portal functions already do.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN
-- ------------------------------------
-- No payment history, no damage detail, no net receivable — only what the three
-- cards show. A partner link is as private as whoever the partner forwards it
-- to, so it carries the least that answers the question.
-- =============================================================================

create or replace function public.partner_portal_stats(
  p_token  text,
  p_period text default null
)
returns table (
  active_items       int,
  completed_this_month int,
  earnings_this_month numeric
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_p      public.finishing_partners;
  v_period text := coalesce(p_period, to_char(now() at time zone 'UTC', 'YYYY-MM'));
begin
  v_p := public.partner_by_token(p_token);
  if v_p.id is null then
    raise exception 'This link is no longer valid.' using errcode = '42501';
  end if;

  return query
  select
    -- Exactly the predicate `partner_portal_work` lists by, so the card and the
    -- list below it can never disagree about how much work is in hand.
    (select count(*)::int
       from public.repeats r
      where r.factory_id = v_p.factory_id
        and r.current_status = 'handed_off'
        and r.current_partner_id = v_p.id),

    -- One ledger EARNING is one completed piece: `partner_ledger` gets an
    -- earning row per repeat the partner finished, which is what makes this a
    -- count of work done rather than of rows touched.
    (select count(*)::int
       from public.partner_ledger pl
      where pl.factory_id = v_p.factory_id
        and pl.partner_id = v_p.id
        and pl.period = v_period
        and pl.entry_type = 'earning'),

    -- Gross earnings for the period. NOT net of damage charges or payments
    -- already made: this card answers "what did I earn this month", and netting
    -- it off would answer a different question in the same space.
    (select coalesce(sum(pl.amount), 0)
       from public.partner_ledger pl
      where pl.factory_id = v_p.factory_id
        and pl.partner_id = v_p.id
        and pl.period = v_period
        and pl.entry_type = 'earning');
end $$;

grant execute on function public.partner_portal_stats(text, text) to anon, authenticated;
