-- =============================================================================
-- Factory ERP — Phase 7 reports.
--
-- Every one is a pure read/aggregate over tables built in earlier phases. No new
-- source-of-truth tables: if a number here is wrong, the fix belongs in the
-- transaction that wrote it, not in a reporting table that could drift.
--
-- All are SECURITY DEFINER and scope explicitly to current_factory_id(), because
-- definer rights bypass the RLS that would otherwise do the scoping.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Shared costing input
-- ---------------------------------------------------------------------------
/**
 * Weighted average cost per metre of thread actually purchased.
 * Falls back to a nominal rate when nothing has been bought yet, so early
 * reports show a plausible figure rather than zero thread cost.
 *
 * Defined before the reports that call it — a SQL-language function's body is
 * validated at creation, so a forward reference fails the migration.
 */
create or replace function public.avg_thread_cost_per_meter()
returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(
      (select sum(po.amount) filter (where po.amount is not null)
         / nullif(sum(pi.quantity_meters), 0)
       from public.purchase_orders po
       join public.po_items pi on pi.purchase_order_id = po.id
       where po.factory_id = public.current_factory_id()
         and po.status in ('paid','handed_over','received')
         and pi.color_code is not null), 0),
    0.5)
$$;

-- ---------------------------------------------------------------------------
-- 1. Company P&L
-- ---------------------------------------------------------------------------
/**
 * Revenue is counted from invoices RAISED in the window (accrual), with cash
 * collected reported alongside — a factory that has invoiced but not been paid
 * needs to see both, and showing only one of them misleads in opposite ways.
 */
create or replace function public.report_company_pl(
  p_from date default null,
  p_to   date default null
)
returns table (
  revenue_invoiced numeric,
  revenue_collected numeric,
  thread_cost      numeric,
  labor_cost       numeric,
  finishing_cost   numeric,
  other_expenses   numeric,
  total_cost       numeric,
  net_profit       numeric
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid),
  bounds as (
    select coalesce(p_from, date '1900-01-01') as d_from,
           coalesce(p_to, current_date) as d_to
  ),
  rev as (
    select coalesce(sum(i.amount), 0) as invoiced
    from public.invoices i, f, bounds
    where i.factory_id = f.fid and i.status <> 'cancelled'
      and i.issued_at::date between bounds.d_from and bounds.d_to
  ),
  coll as (
    select coalesce(sum(p.amount), 0) as collected
    from public.payments p, f, bounds
    where p.factory_id = f.fid and p.direction = 'receivable'
      and p.paid_at::date between bounds.d_from and bounds.d_to
  ),
  -- Thread consumed, valued at the cost the factory actually paid per metre.
  thread as (
    select coalesce(sum(-m.quantity_meters) * public.avg_thread_cost_per_meter(), 0) as cost
    from public.stock_movements m, f, bounds
    where m.factory_id = f.fid and m.movement_type = 'issue'
      and m.created_at::date between bounds.d_from and bounds.d_to
  ),
  labor as (
    select coalesce(sum(wl.net), 0) as cost
    from public.worker_ledger wl, f, bounds
    where wl.factory_id = f.fid
      and to_date(wl.period || '-01', 'YYYY-MM')
          between date_trunc('month', bounds.d_from)::date and bounds.d_to
  ),
  fin as (
    select coalesce(sum(e.amount), 0) as cost
    from public.expenses e, f, bounds
    where e.factory_id = f.fid and e.category = 'partner_payment'
      and e.status = 'approved'
      and e.expense_date between bounds.d_from and bounds.d_to
  ),
  other as (
    select coalesce(sum(e.amount), 0) as cost
    from public.expenses e, f, bounds
    where e.factory_id = f.fid and e.category <> 'partner_payment'
      and e.status = 'approved'
      and e.expense_date between bounds.d_from and bounds.d_to
  )
  select rev.invoiced, coll.collected, thread.cost, labor.cost, fin.cost, other.cost,
         (thread.cost + labor.cost + fin.cost + other.cost),
         rev.invoiced - (thread.cost + labor.cost + fin.cost + other.cost)
  from rev, coll, thread, labor, fin, other
$$;

-- ---------------------------------------------------------------------------
-- 2. Per-order profitability — the product's differentiator
-- ---------------------------------------------------------------------------
/**
 * Revenue minus thread, labour, finishing and an allocated share of fixed
 * expenses, per order.
 *
 * How each cost is attributed (each traceable to a real transaction):
 *   thread    — `stock_movements` issue rows whose material_issue points at this
 *               order, valued at the average purchase cost per metre
 *   labour    — `worker_ledger` rows for shifts run against this order
 *   finishing — `partner_ledger` earnings tied to this order's stages
 *   fixed     — approved non-partner expenses in the window, shared evenly
 *               across the orders invoiced in it
 *
 * Fixed-cost allocation is deliberately simple and stated in the UI: pretending
 * to a precision the data cannot support would be worse than being explicit.
 */
create or replace function public.report_order_profitability(p_order_id uuid default null)
returns table (
  order_id        uuid,
  order_code      text,
  vendor_name     text,
  status          text,
  invoice_code    text,
  revenue         numeric,
  thread_cost     numeric,
  labor_cost      numeric,
  finishing_cost  numeric,
  fixed_allocated numeric,
  total_cost      numeric,
  profit          numeric,
  margin_pct      numeric
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid),
  rate as (select public.avg_thread_cost_per_meter() as per_meter),
  scope as (
    select o.id, o.order_code, o.status, v.name as vendor_name
    from public.orders o
    join public.vendors v on v.id = o.vendor_id, f
    where o.factory_id = f.fid
      and (p_order_id is null or o.id = p_order_id)
  ),
  inv as (
    select i.order_id, i.invoice_code, i.amount
    from public.invoices i, f
    where i.factory_id = f.fid and i.status <> 'cancelled'
  ),
  thread as (
    select mi.order_id, sum(-m.quantity_meters) * (select per_meter from rate) as cost
    from public.stock_movements m
    join public.material_issues mi on mi.id = m.ref_id
    where m.movement_type = 'issue' and m.ref_type = 'material_issue'
    group by mi.order_id
  ),
  labor as (
    select s.order_id, sum(wl.net) as cost
    from public.worker_ledger wl
    join public.shifts s on s.id = wl.shift_id
    where s.order_id is not null
    group by s.order_id
  ),
  finishing as (
    select os.order_id, sum(pl.amount) as cost
    from public.partner_ledger pl
    join public.order_stages os on os.id = pl.order_stage_id
    where pl.entry_type = 'earning'
    group by os.order_id
  ),
  -- Fixed overhead in the period, shared evenly across invoiced orders.
  fixed as (
    select case when (select count(*) from inv) = 0 then 0
                else coalesce((
                  select sum(e.amount) from public.expenses e, f
                   where e.factory_id = f.fid and e.status = 'approved'
                     and e.category not in ('partner_payment','materials')
                ), 0) / (select count(*) from inv)
           end as per_order
  )
  select
    sc.id, sc.order_code, sc.vendor_name, sc.status,
    inv.invoice_code,
    coalesce(inv.amount, 0),
    round(coalesce(thread.cost, 0), 2),
    round(coalesce(labor.cost, 0), 2),
    round(coalesce(finishing.cost, 0), 2),
    round(case when inv.order_id is null then 0 else (select per_order from fixed) end, 2),
    round(coalesce(thread.cost, 0) + coalesce(labor.cost, 0) + coalesce(finishing.cost, 0)
          + case when inv.order_id is null then 0 else (select per_order from fixed) end, 2),
    round(coalesce(inv.amount, 0)
          - (coalesce(thread.cost, 0) + coalesce(labor.cost, 0) + coalesce(finishing.cost, 0)
             + case when inv.order_id is null then 0 else (select per_order from fixed) end), 2),
    case when coalesce(inv.amount, 0) = 0 then null
         else round(100 * (coalesce(inv.amount, 0)
              - (coalesce(thread.cost, 0) + coalesce(labor.cost, 0) + coalesce(finishing.cost, 0)
                 + (select per_order from fixed))) / inv.amount, 1)
    end
  from scope sc
  left join inv on inv.order_id = sc.id
  left join thread on thread.order_id = sc.id
  left join labor on labor.order_id = sc.id
  left join finishing on finishing.order_id = sc.id
  order by sc.order_code
$$;

-- ---------------------------------------------------------------------------
-- 3. Inventory consumption & leakage
-- ---------------------------------------------------------------------------
/**
 * Reads the whole `stock_movements` log built in Phase 4 and surfaces, per
 * colour, what came in, what was issued, and what the audits had to correct.
 *
 * The audit variance IS the leakage signal: thread that left the shelf without
 * an issue behind it. `leakage_pct` expresses it against what was issued, so a
 * small absolute variance on a high-turnover colour reads differently from the
 * same variance on a rarely-used one.
 */
create or replace function public.report_inventory_leakage()
returns table (
  color_code        text,
  opening_meters    numeric,
  received_meters   numeric,
  issued_meters     numeric,
  audit_variance    numeric,
  current_balance   numeric,
  expected_balance  numeric,
  leakage_pct       numeric,
  movement_count    int
)
language sql stable security definer set search_path = public as $$
  select
    m.color_code,
    coalesce(sum(m.quantity_meters) filter (where m.movement_type = 'opening'), 0),
    coalesce(sum(m.quantity_meters) filter (where m.movement_type = 'grn'), 0),
    coalesce(-sum(m.quantity_meters) filter (where m.movement_type = 'issue'), 0),
    coalesce(sum(m.quantity_meters) filter (where m.movement_type = 'audit_variance'), 0),
    coalesce(ts.quantity_meters, 0),
    -- What the balance would be if no audit had ever corrected it.
    coalesce(sum(m.quantity_meters) filter (where m.movement_type <> 'audit_variance'), 0),
    case
      when coalesce(-sum(m.quantity_meters) filter (where m.movement_type = 'issue'), 0) = 0
        then null
      else round(100 * abs(coalesce(sum(m.quantity_meters)
             filter (where m.movement_type = 'audit_variance'), 0))
           / (-sum(m.quantity_meters) filter (where m.movement_type = 'issue')), 2)
    end,
    count(*)::int
  from public.stock_movements m
  left join public.thread_stock ts on ts.id = m.thread_stock_id
  where m.factory_id = public.current_factory_id()
  group by m.color_code, ts.quantity_meters
  order by m.color_code
$$;

-- ---------------------------------------------------------------------------
-- 4. Worker productivity
-- ---------------------------------------------------------------------------
create or replace function public.report_worker_productivity(p_period text default null)
returns table (
  worker_id        uuid,
  worker_name      text,
  periods          int,
  shifts_worked    int,
  total_stitches   bigint,
  avg_stitches     numeric,
  gross_pay        numeric,
  bonus            numeric,
  damage_deduction numeric,
  loan_installment numeric,
  net_pay          numeric,
  damage_count     int
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid)
  select
    p.id, p.display_name,
    count(distinct wl.period)::int,
    count(wl.shift_id)::int,
    coalesce(sum(wl.stitch_count), 0)::bigint,
    round(coalesce(avg(nullif(wl.stitch_count, 0)), 0), 0),
    round(coalesce(sum(wl.stitch_count * wl.base_per_stitch), 0), 2),
    round(coalesce(sum(wl.bonus), 0), 2),
    round(coalesce(sum(wl.damage_deduction), 0), 2),
    round(coalesce(sum(wl.loan_installment), 0), 2),
    round(coalesce(sum(wl.net), 0), 2),
    (select count(*)::int from public.damage_records d
      where d.responsible_type = 'worker' and d.responsible_id = p.id
        and d.approval_status = 'approved')
  from public.profiles p
  join f on true
  left join public.worker_ledger wl
         on wl.worker_id = p.id and wl.factory_id = f.fid
        and (p_period is null or wl.period = p_period)
  where p.factory_id = f.fid and p.role = 'worker'
  group by p.id, p.display_name
  order by coalesce(sum(wl.stitch_count), 0) desc
$$;

-- ---------------------------------------------------------------------------
-- 5. Machine uptime / downtime
-- ---------------------------------------------------------------------------
/**
 * Uptime is measured against the elapsed span of closed shifts, with reported
 * downtime subtracted. Shifts flagged idle are counted separately rather than
 * folded into downtime — an idle flag means the counter did not move, which is
 * a different fact from a reported stoppage and should not be silently merged.
 */
create or replace function public.report_machine_uptime(
  p_from date default null,
  p_to   date default null
)
returns table (
  machine_id       uuid,
  machine_name     text,
  shifts_total     int,
  shifts_closed    int,
  shifts_idle      int,
  run_minutes      numeric,
  downtime_minutes numeric,
  uptime_pct       numeric,
  total_stitches   bigint,
  downtime_events  int
)
language sql stable security definer set search_path = public as $$
  with f as (select public.current_factory_id() as fid),
  bounds as (
    select coalesce(p_from, date '1900-01-01') as d_from,
           coalesce(p_to, current_date) as d_to
  ),
  sh as (
    select s.*,
           extract(epoch from (coalesce(s.closed_at, now()) - s.opened_at)) / 60 as span_min
    from public.shifts s, f, bounds
    where s.factory_id = f.fid
      and s.opened_at::date between bounds.d_from and bounds.d_to
  ),
  dt as (
    select d.shift_id, sum(d.duration_minutes) as mins, count(*)::int as events
    from public.downtime_reports d, f
    where d.factory_id = f.fid
    group by d.shift_id
  )
  select
    m.id, m.name,
    count(sh.id)::int,
    count(sh.id) filter (where sh.status = 'closed')::int,
    count(sh.id) filter (where sh.status = 'flagged_idle')::int,
    round(coalesce(sum(sh.span_min) filter (where sh.status = 'closed'), 0), 1),
    round(coalesce(sum(dt.mins), 0), 1),
    case
      when coalesce(sum(sh.span_min) filter (where sh.status = 'closed'), 0) = 0 then null
      else round(100 * greatest(
             coalesce(sum(sh.span_min) filter (where sh.status = 'closed'), 0)
             - coalesce(sum(dt.mins), 0), 0)
           / sum(sh.span_min) filter (where sh.status = 'closed'), 1)
    end,
    coalesce(sum(sh.confirmed_stitches), 0)::bigint,
    coalesce(sum(dt.events), 0)::int
  from public.machines m
  join f on true
  left join sh on sh.machine_id = m.id
  left join dt on dt.shift_id = sh.id
  where m.factory_id = f.fid and m.deleted_at is null
  group by m.id, m.name
  order by m.name
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.avg_thread_cost_per_meter() to authenticated;
grant execute on function public.report_company_pl(date, date) to authenticated;
grant execute on function public.report_order_profitability(uuid) to authenticated;
grant execute on function public.report_inventory_leakage() to authenticated;
grant execute on function public.report_worker_productivity(text) to authenticated;
grant execute on function public.report_machine_uptime(date, date) to authenticated;
