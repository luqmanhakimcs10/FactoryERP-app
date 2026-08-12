-- =============================================================================
-- Factory ERP — the stitches -> requirement -> PO -> approval chain.
--
-- Four connected defects, one of which causes two of the others.
--
-- ROOT CAUSE: TWO FIELDS FOR ONE NUMBER
-- -------------------------------------
-- "Stitches per repeat" exists twice and the two are unrelated:
--
--   sheets.stitch_count            set by the ORDER TAKER when the order is made
--   job_cards.stitches_per_repeat  set by the FLOOR MANAGER in the Job Card
--                                  Builder (0048) — the field the UI actually
--                                  shows and the one people fill in
--
-- `fm_generate_job_card` derives each needle line's stitches from the FIRST:
--     (sheets.stitch_count x repeats) / number_of_colours
--
-- Every sheet in this database has stitch_count = 0, so every generated line is
-- born at 0 while the Builder happily shows "Stitches per repeat: 20". The Job
-- Card's Stitches column, the per-colour cone requirement, the shortfall and the
-- auto-PO are all downstream of that zero, which is why one root cause produced
-- four symptoms.
--
-- The fix is a fallback, not a rename: where the sheet carries a real figure it
-- is still used (it is the more specific number, per sheet), and the job card's
-- figure fills in when the sheet has none. Making one the sole source would
-- silently discard whichever data the other already holds.
--
-- BUG 3: ISSUING WAS ONLY BLOCKED IN THE UI
-- -----------------------------------------
-- IssueDetailScreen already disables the button when a colour is short. But with
-- a requirement of 0 the check `available >= required` is `0 >= 0` — true — so
-- nothing was short and the button stayed live. And `sm_issue_materials` itself
-- has never checked sufficiency at all: it only fails if a movement would drive
-- stock negative, which a zero requirement never does. A UI-only guard is the
-- pattern this project's own rule rejects, so the refusal moves into the RPC.
--
-- BUG 5: THE APPROVALS INBOX NEVER SHOWED POs
-- -------------------------------------------
-- `owner_approvals_queue` unions expenses, damage records and bonus-slab
-- proposals. Purchase orders sitting at `awaiting_approval` were never in it,
-- so a PO could show "Awaiting Owner Approval" on its own screen while the
-- owner's inbox showed nothing of it. Not a linkage bug — the query simply
-- never asked.
--
-- The first draft of this section was REWRITTEN from memory rather than
-- extracted, and it: invented a `deduction_amount` column that has never
-- existed (the real one is `deduction`), replaced the real
-- `approval_status = 'pending'` filter with three predicates of my own, and
-- dropped the entire bonus_slab branch — which would have silently removed a
-- whole approval type from the owner's inbox. The wrong column name is what
-- made it fail loudly; the other two would not have. This version is 0024's
-- body with ONE branch appended, generated from that file rather than retyped.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. A sanity bound on stitches per repeat — FIRST, because everything below
--    multiplies by it.
--
-- This database holds 25,555,484,848 in one job card and 555,555,886 in another,
-- neither of which any validation caught. `job_card_lines.stitch_count` is an
-- `int`, so 25.5 billion x 2 repeats is 51 billion and overflows it — the first
-- draft of this migration died on exactly that, which is how the values came to
-- light.
--
-- `not valid` deliberately: it stops NEW nonsense without failing the migration
-- on the two rows already there. Those are reported at the end instead, because
-- silently rewriting a number a person typed is worse than telling them it is
-- wrong. A card carrying one cannot be re-saved until it is corrected, which is
-- the right kind of friction.
--
-- 10,000,000 stitches per repeat is the bound: roughly 28 cones for ONE repeat
-- at 350,000/cone, already far beyond any real garment.
-- ---------------------------------------------------------------------------
alter table public.job_cards drop constraint if exists job_cards_stitches_sane_chk;
alter table public.job_cards add constraint job_cards_stitches_sane_chk
  check (stitches_per_repeat is null or stitches_per_repeat between 0 and 10000000)
  not valid;

-- ---------------------------------------------------------------------------
-- 1. Needle lines are born with real stitches.
--
-- Regenerated from 0037's body (the current definition) with the stitch
-- expression changed, per the rule this session settled on after two regressions
-- from retyping older versions.
-- ---------------------------------------------------------------------------
create or replace function public.fm_generate_job_card(p_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_card_id uuid;
  v_lines   int;
  v_per_rep int;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select id, coalesce(stitches_per_repeat, 0)
    into v_card_id, v_per_rep
    from public.job_cards where order_id = p_order_id;

  if v_card_id is null then
    insert into public.job_cards (factory_id, order_id, status)
    values (v_order.factory_id, p_order_id, 'draft')
    returning id into v_card_id;
    v_per_rep := 0;
  else
    if (select status from public.job_cards where id = v_card_id) <> 'draft' then
      raise exception 'A job card can only be generated before confirmation (status: %).',
        (select status from public.job_cards where id = v_card_id) using errcode = '22023';
    end if;
    delete from public.job_card_lines where job_card_id = v_card_id;
  end if;

  -- Distinct colours in first-appearance order -> sequential needle numbers.
  insert into public.job_card_lines
    (factory_id, job_card_id, sheet_id, needle_number, thread_color_code, stitch_count)
  select
    v_order.factory_id,
    v_card_id,
    null,
    row_number() over (order by c.first_sheet, c.color_code),
    c.color_code,
    c.stitches
  from (
    select
      col.code as color_code,
      min(s.sheet_number) as first_sheet,
      -- least(...) before the ::int cast. stitch_count is an int, and without
      -- the clamp an absurd stitches_per_repeat raises 22003 and takes the whole
      -- job card generation down. The constraint above stops new nonsense; this
      -- keeps the function from crashing on nonsense already stored.
      least(
        sum(
          (
            -- THE FIX. The sheet's own figure when it has one; otherwise the Job
            -- Card Builder's "stitches per repeat", which is the field the floor
            -- manager actually fills in and the one that was being ignored.
            case when coalesce(s.stitch_count, 0) > 0
                 then s.stitch_count::numeric
                 else v_per_rep::numeric
            end * s.repeats_count
          ) / greatest(coalesce(array_length(s.thread_color_codes,1),0),1)
        ),
        2000000000::numeric
      )::int as stitches
    from public.sheets s
    cross join lateral unnest(s.thread_color_codes) as col(code)
    where s.order_id = p_order_id
    group by col.code
  ) c;

  select count(*) into v_lines from public.job_card_lines where job_card_id = v_card_id;

  update public.orders set status = 'job_card_shared'
   where id = p_order_id and status = 'awaiting_job_card';

  return jsonb_build_object('job_card_id', v_card_id, 'lines', v_lines);
end $$;

grant execute on function public.fm_generate_job_card(uuid) to authenticated;

-- Repair the lines already sitting at zero, using the same rule.
--
-- Only touches lines that are 0 or null AND whose job card has a real per-repeat
-- figure, so a deliberately-entered value is never overwritten. Rows whose
-- computed value will not fit in an `int` are SKIPPED rather than clamped: a
-- clamped 2,000,000,000 would be a number nobody entered, sitting in a field the
-- purchase-order calculation trusts. They are named in a notice instead.
do $$
declare
  n_fixed   int := 0;
  n_skipped int := 0;
  bad       text;
begin
  with candidate as (
    select jcl.id,
           ceil(
             (jc.stitches_per_repeat::numeric * coalesce(sh.total_repeats, 0))
             / greatest(cnt.colour_count, 1)
           ) as stitches
      from public.job_card_lines jcl
      join public.job_cards jc on jc.id = jcl.job_card_id
      left join lateral (
        select sum(s.repeats_count) as total_repeats
          from public.sheets s where s.order_id = jc.order_id
      ) sh on true
      join lateral (
        select count(*) as colour_count
          from public.job_card_lines x where x.job_card_id = jc.id
      ) cnt on true
     where coalesce(jcl.stitch_count, 0) = 0
       and coalesce(jc.stitches_per_repeat, 0) > 0
  )
  update public.job_card_lines jcl
     set stitch_count = c.stitches::int
    from candidate c
   where jcl.id = c.id
     -- The guard the first draft was missing.
     and c.stitches between 1 and 2000000000;
  get diagnostics n_fixed = row_count;

  select count(*), string_agg(distinct jc.stitches_per_repeat::text, ', ')
    into n_skipped, bad
    from public.job_card_lines jcl
    join public.job_cards jc on jc.id = jcl.job_card_id
   where coalesce(jcl.stitch_count, 0) = 0
     and coalesce(jc.stitches_per_repeat, 0) > 10000000;

  if n_fixed > 0 then
    raise notice 'filled % needle line(s) that were stranded at zero', n_fixed;
  end if;
  if n_skipped > 0 then
    raise notice
      'SKIPPED % line(s): their job card holds an impossible stitches_per_repeat (%). '
      'Correct those job cards by hand — the value was never entered deliberately.',
      n_skipped, bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The Issue Materials requirement becomes the REAL per-colour figure.
--
-- `job_card_requirements` fed IssueDetailScreen from
-- `order_thread_requirements` — the metre-based estimate that splits a sheet's
-- stitches evenly across its colours. It now reports cones from the per-needle
-- counts (0082), which is the same number the shortfall PO is raised against.
-- Two screens disagreeing about how much thread an order needs is worse than
-- either being wrong on its own.
--
-- Column names are kept (`required_meters` / `available_meters`) so the screen
-- and its types need no change. They now carry CONES; the unit was already a
-- lie for cone-counted thread before this.
-- ---------------------------------------------------------------------------
create or replace function public.job_card_requirements(p_job_card_id uuid)
returns table (
  color_code       text,
  required_meters  numeric,
  available_meters numeric,
  sufficient       boolean
)
language sql stable security definer set search_path = public as $$
  select r.color_code,
         r.cones_needed::numeric,
         r.cones_available,
         -- Unknown stitches is NOT sufficient. Treating "nobody entered it" as
         -- "needs nothing" is exactly how material got issued against 0.
         r.stitches_known and r.cones_available >= r.cones_needed
    from public.job_cards jc
    join public.order_color_requirements(jc.order_id) r on true
   where jc.id = p_job_card_id
     and jc.factory_id = public.current_factory_id()
   order by r.color_code
$$;

grant execute on function public.job_card_requirements(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Issuing refuses in the DATABASE, not just in the screen.
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
  v_bad     text;
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

  -- Nothing may be issued while a colour is short, or while any needle's stitch
  -- count is still missing. Both were previously invisible here: a requirement
  -- of zero passes `available >= required` and deducts nothing, so the issue
  -- "succeeded" and the floor was told material was on its way.
  select string_agg(
           cr.color_code || ' (' || cr.cones_needed || ' needed, '
             || cr.cones_available || ' held)', ', ' order by cr.color_code)
    into v_bad
    from public.order_color_requirements(v_card.order_id) cr
   where not cr.stitches_known or cr.cones_available < cr.cones_needed;

  if v_bad is not null then
    raise exception 'Not enough thread to issue: %. Order the shortfall first.', v_bad
      using errcode = '22023';
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

    -- 0051: a requirement that rounds to 0 must not write a movement, because
    -- an 'issue' row has to be strictly negative.
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

  update public.material_requests
     set status = 'issued', material_issue_id = v_issue.id
   where job_card_id = p_job_card_id and status = 'pending';

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
-- 4. Purchase orders awaiting the owner appear in the owner's inbox.
--
-- Same shape as the other two kinds, so ApprovalsInboxScreen needs no change
-- beyond knowing the new `kind`. The subtitle carries the PO's real lines, so
-- the row says what is actually being approved rather than a generic label.
-- ---------------------------------------------------------------------------
create or replace function public.owner_approvals_queue()
returns table (
  kind        text,
  id          uuid,
  title       text,
  subtitle    text,
  amount      numeric,
  created_at  timestamptz
)
language sql stable security definer set search_path = public as $$
  select 'expense', e.id,
         initcap(replace(e.category, '_', ' ')),
         coalesce(e.description, 'No description'),
         e.amount, e.created_at
  from public.expenses e
  where e.factory_id = public.current_factory_id() and e.status = 'pending'

  union all

  select 'damage', d.id,
         initcap(d.damage_type) || ' — ' || d.responsible_type || ' accountable',
         coalesce((select order_code from public.orders o where o.id = d.order_id), '')
           || coalesce(' · ' || (select repeat_code from public.repeats r where r.id = d.repeat_id), ''),
         d.deduction, d.created_at
  from public.damage_records d
  where d.factory_id = public.current_factory_id() and d.approval_status = 'pending'

  union all

  select 'bonus_slab', p.id,
         'Bonus slab: ' || p.action,
         coalesce(p.reason, '') ||
           coalesce(' · ' || p.daily_stitch_threshold::text || ' stitches', '') ||
           coalesce(' -> ' || p.bonus_amount::text, ''),
         p.bonus_amount, p.created_at
  from public.bonus_slab_proposals p
  where p.factory_id = public.current_factory_id() and p.status = 'pending'

  union all

  -- NEW in 0083. A PO at awaiting_approval is waiting on exactly this person,
  -- and this query never asked about purchase orders at all — which is why a PO
  -- could read "Awaiting Owner Approval" on its own screen while the owner's
  -- inbox showed nothing of it. Not a broken linkage: a missing branch.
  select 'purchase_order', po.id,
         po.po_code || ' — ' || coalesce(s.name, 'no supplier'),
         coalesce(
           (select string_agg(
                     coalesce(pi.color_code, pi.description, 'item')
                       || ' x ' || pi.quantity_meters, ', ' order by pi.color_code)
              from public.po_items pi where pi.purchase_order_id = po.id),
           'no lines'),
         coalesce(po.amount, 0), coalesce(po.created_at, now())
  from public.purchase_orders po
  left join public.suppliers s on s.id = po.supplier_id
  where po.factory_id = public.current_factory_id()
    and po.status = 'awaiting_approval'

  order by created_at
$$;

grant execute on function public.owner_approvals_queue() to authenticated;

-- ---------------------------------------------------------------------------
-- Job cards carrying an impossible figure. Fix or delete these by hand; the
-- constraint above stops new ones but deliberately leaves existing rows alone.
-- ---------------------------------------------------------------------------
select jc.id, o.order_code, jc.status, jc.stitches_per_repeat,
       'above the 10,000,000 bound — correct this card' as note
  from public.job_cards jc
  join public.orders o on o.id = jc.order_id
 where coalesce(jc.stitches_per_repeat, 0) > 10000000
 order by jc.stitches_per_repeat desc;
