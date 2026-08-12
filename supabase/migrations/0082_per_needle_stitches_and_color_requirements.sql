-- =============================================================================
-- Factory ERP — real stitches per needle, and a per-COLOUR thread requirement.
--
-- THE GAP
-- -------
-- `job_card_lines.stitch_count` has existed since 0007 and nothing has ever
-- written it, so the Job Card's "Stitches" column has always rendered empty. The
-- display was the visible half. The real cost is that thread consumption could
-- only ever be estimated: `order_thread_requirements` (0008) takes a sheet's
-- stitch_count, multiplies by repeats, and splits the result EVENLY across that
-- sheet's colours. Two colours on one sheet always come out identical, whatever
-- the design actually does — so a shortfall PO for a specific colour was a guess
-- wearing a number.
--
-- WHERE THIS CAN AND CANNOT RUN — read this before wiring it anywhere else
-- ------------------------------------------------------------------------
-- The brief asks for the accurate calculation at "order submission's automatic
-- stock check". That is not possible, and it is worth being exact about why
-- rather than quietly doing something else.
--
-- The sequence is:
--     submit_order        <- the stock check and auto-PO live here
--     QA cloth inspection
--     QA repeat coding
--     fm_generate_job_card
--     fm_add_job_card_line  <- needle lines, and therefore stitches, first exist HERE
--     job card confirmed
--     fm_ask_for_material
--
-- Needle lines are created three steps AFTER the check that wants them. At
-- submission there is no per-needle data in existence, so submit_order keeps its
-- sheet-level estimate — it is the only thing that can be computed at that point,
-- and it still catches the gross "we have none of this colour" case.
--
-- The accurate check is therefore added at `fm_ask_for_material`, the first
-- moment real needle data exists AND the moment it matters: that request is what
-- leads to material being issued. A shortfall found there raises or extends the
-- order's PO with the exact per-colour quantity.
--
-- THE CONVERSION
-- --------------
-- 350,000 stitches per cone, per the brief. cones = ceil(stitches / 350000).
--
-- FLAGGED ASSUMPTION: the brief says "per cone, per head" but gives the formula
-- without a head term, so the formula is implemented as written. If a 12-head
-- machine really consumes one cone per head, the true figure is this multiplied
-- by head count and every result here is 12x low. The head count is not on the
-- job card today, which is why it cannot simply be included. Say the word and it
-- becomes `ceil(stitches / 350000) * heads`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Stitches become required on a needle line.
--
-- The column already exists and is nullable. It STAYS nullable rather than
-- becoming NOT NULL: every line written before today has null, and a NOT NULL
-- backfilled with a made-up number would turn "we never captured this" into a
-- figure the requirement calculation would then trust. Null means unknown and is
-- reported as such below.
--
-- New lines cannot be null: the RPC requires it, and the 2-arg version is
-- DROPPED so nothing can keep calling the old shape. PostgREST resolves overloads
-- by argument name, so leaving it in place would let the app carry on adding
-- stitch-less lines forever.
-- ---------------------------------------------------------------------------
drop function if exists public.fm_add_job_card_line(uuid, text);

create or replace function public.fm_add_job_card_line(
  p_job_card_id       uuid,
  p_thread_color_code text,
  p_stitch_count      int
)
returns public.job_card_lines
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_card    public.job_cards;
  v_next    int;
  v_line    public.job_card_lines;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);

  select * into v_card from public.job_cards where id = p_job_card_id;
  if not found or v_card.factory_id is distinct from v_factory then
    perform public.raise_not_found('Job card not found.');
  end if;
  if v_card.status <> 'draft' then
    raise exception 'Needle lines can only be changed while the job card is a draft (status: %).',
      v_card.status using errcode = '22023';
  end if;
  if coalesce(trim(p_thread_color_code), '') = '' then
    raise exception 'A thread colour is required.' using errcode = '22023';
  end if;
  if p_stitch_count is null or p_stitch_count <= 0 then
    raise exception 'Stitches for this needle must be greater than zero.' using errcode = '22023';
  end if;

  -- Needle numbers stay positional (0053): the next one, never a chosen one.
  select coalesce(max(needle_number), 0) + 1 into v_next
    from public.job_card_lines where job_card_id = p_job_card_id;

  if v_next > 6 then
    raise exception 'Needle numbers are capped at 6 — this job card already has %.', v_next - 1
      using errcode = '22023';
  end if;

  insert into public.job_card_lines
    (factory_id, job_card_id, needle_number, thread_color_code, stitch_count)
  values (v_factory, p_job_card_id, v_next, trim(p_thread_color_code), p_stitch_count)
  returning * into v_line;

  return v_line;
end $$;

grant execute on function public.fm_add_job_card_line(uuid, text, int) to authenticated;

-- Editing a line can change its stitches too. Same reasoning for dropping the
-- old signature: an app still calling the 4-arg version would silently wipe
-- nothing, but it also could never SET stitches, which is the point of this
-- migration.
drop function if exists public.fm_update_job_card_line(uuid, uuid, int, text);

create or replace function public.fm_update_job_card_line(
  p_job_card_id       uuid,
  p_line_id           uuid,
  p_needle_number     int,
  p_thread_color_code text,
  p_stitch_count      int
)
returns public.job_card_lines
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid := public.current_factory_id();
  v_card    public.job_cards;
  v_line    public.job_card_lines;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);

  select * into v_card from public.job_cards where id = p_job_card_id;
  if not found or v_card.factory_id is distinct from v_factory then
    perform public.raise_not_found('Job card not found.');
  end if;
  if v_card.status <> 'draft' then
    raise exception 'Needle lines can only be changed while the job card is a draft (status: %).',
      v_card.status using errcode = '22023';
  end if;
  if coalesce(trim(p_thread_color_code), '') = '' then
    raise exception 'A thread colour is required.' using errcode = '22023';
  end if;
  if p_stitch_count is null or p_stitch_count <= 0 then
    raise exception 'Stitches for this needle must be greater than zero.' using errcode = '22023';
  end if;

  update public.job_card_lines
     set needle_number     = p_needle_number,
         thread_color_code = trim(p_thread_color_code),
         stitch_count      = p_stitch_count
   where id = p_line_id and job_card_id = p_job_card_id
  returning * into v_line;

  if not found then
    perform public.raise_not_found('Needle line not found.');
  end if;

  return v_line;
end $$;

grant execute on function public.fm_update_job_card_line(uuid, uuid, int, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The per-colour requirement.
--
-- One row per thread colour on the job card:
--   total_stitches = that needle's stitches x the repeats it runs over
--   cones_needed   = ceil(total_stitches / 350000)
--   shortfall      = what is missing against inventory_items right now
--
-- WHICH REPEAT COUNT
-- A line may name a sheet (`job_card_lines.sheet_id`). When it does, it runs over
-- THAT sheet's repeats. When it does not — which is every line the current UI
-- creates — it applies to the whole order, so the order's total repeats are used.
-- Getting this wrong in either direction is the difference between ordering
-- enough thread and not, so both cases are handled rather than assumed away.
--
-- `stitches_known` is returned so a caller can tell "this colour needs nothing"
-- apart from "nobody ever entered the stitches". They are very different, and
-- collapsing them is how a shortfall silently becomes zero.
-- ---------------------------------------------------------------------------
create or replace function public.order_color_requirements(p_order_id uuid)
returns table (
  color_code      text,
  total_stitches  bigint,
  cones_needed    int,
  cones_available numeric,
  cones_short     int,
  stitches_known  boolean
)
language sql stable security definer set search_path = public as $$
  with order_repeats as (
    select coalesce(sum(s.repeats_count), 0)::int as n
      from public.sheets s
     where s.order_id = p_order_id
  ),
  per_line as (
    select jcl.thread_color_code as code,
           jcl.stitch_count,
           case
             when jcl.sheet_id is not null
               then coalesce((select s.repeats_count from public.sheets s where s.id = jcl.sheet_id), 0)
             else (select n from order_repeats)
           end as repeats
      from public.job_card_lines jcl
      join public.job_cards jc on jc.id = jcl.job_card_id
     where jc.order_id = p_order_id
       and jc.factory_id = public.current_factory_id()
  ),
  per_color as (
    select code,
           sum(coalesce(stitch_count, 0)::bigint * repeats)     as stitches,
           bool_and(stitch_count is not null)                    as known
      from per_line
     group by code
  )
  select pc.code,
         pc.stitches,
         ceil(pc.stitches::numeric / 350000)::int,
         coalesce(ii.quantity, 0),
         greatest(
           ceil(pc.stitches::numeric / 350000)::int - floor(coalesce(ii.quantity, 0))::int,
           0
         ),
         pc.known
    from per_color pc
    left join public.inventory_items ii
           on ii.factory_id = public.current_factory_id()
          and ii.item_type = 'thread'
          and ii.color_code = pc.code
   order by pc.code
$$;

grant execute on function public.order_color_requirements(uuid) to authenticated;

comment on function public.order_color_requirements(uuid) is
  'Per-colour thread requirement from real per-needle stitch counts, at 350,000 '
  'stitches per cone. Only meaningful once the job card has needle lines — before '
  'that, submit_order''s sheet-level estimate is all that exists.';

-- ---------------------------------------------------------------------------
-- 3. The accurate check, at the first point the data exists.
--
-- `fm_ask_for_material` already flags the job card and writes the Requests-tab
-- row (0070). It now also runs the per-colour check and, where a colour is short,
-- raises or EXTENDS the order's shortfall PO with that colour's exact figure.
--
-- Extends rather than always creating: submit_order may already have raised an
-- auto PO for this order from its estimate. A second PO for the same order would
-- have procurement buying the same thread twice. Existing lines are updated to
-- the accurate number and only genuinely new colours are appended.
--
-- Asking for material is NOT blocked by a shortfall. The store manager can still
-- issue what they have, and refusing the request would strand the floor over a
-- purchasing problem they cannot solve. The PO is the mechanism; the block is not.
-- ---------------------------------------------------------------------------
create or replace function public.fm_ask_for_material(p_order_id uuid)
returns public.job_cards
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.orders;
  v_card    public.job_cards;
  v_factory uuid := public.current_factory_id();
  v_po_id   uuid;
  r         record;
  v_short   int := 0;
begin
  perform public.assert_module('order_lifecycle');
  perform public.assert_role(array['floor_manager','company_admin']);
  v_order := public.assert_my_order(p_order_id);

  select * into v_card from public.job_cards where order_id = p_order_id;
  if not found then
    raise exception 'There is no job card on this order.' using errcode = 'P0002';
  end if;
  if v_card.status <> 'confirmed' then
    raise exception 'The job card must be confirmed before material can be requested (status: %).', v_card.status
      using errcode = '22023';
  end if;
  if v_card.material_requested_at is not null then
    raise exception 'Material has already been requested for this job card.' using errcode = '22023';
  end if;

  update public.job_cards
     set material_requested_at = now()
   where id = v_card.id
  returning * into v_card;

  -- The history row for the Requests tab, in the same transaction as the flag it
  -- mirrors so the two can never disagree.
  insert into public.material_requests
    (factory_id, request_code, order_id, job_card_id, origin, directed_to,
     status, requested_by)
  values
    (v_factory,
     public.make_code(v_factory, 'MR', public.next_counter(v_factory, 'request_seq')),
     p_order_id, v_card.id, 'job_card', 'store_manager', 'pending', auth.uid())
  on conflict (job_card_id) where job_card_id is not null do nothing;

  -- ---- the accurate per-colour check -------------------------------------
  for r in
    select * from public.order_color_requirements(p_order_id)
     where cones_short > 0 and stitches_known
  loop
    if v_po_id is null then
      -- Reuse this order's open auto PO if there is one, rather than raising a
      -- second for the same order.
      select po.id into v_po_id
        from public.purchase_orders po
       where po.factory_id = v_factory
         and po.order_id = p_order_id
         and po.status not in ('received','cancelled')
       order by po.created_at desc
       limit 1;

      if v_po_id is null then
        insert into public.purchase_orders
          (factory_id, po_code, order_id, status, auto_created, origin)
        values
          (v_factory,
           public.make_code(v_factory, 'PO', public.next_counter(v_factory, 'po_seq')),
           p_order_id, 'auto_generated', true, 'auto_shortfall')
        returning id into v_po_id;
      end if;
    end if;

    -- Set, not add: this figure REPLACES whatever estimate was there for the
    -- colour. Adding would stack the accurate number on top of the guess.
    update public.po_items
       set quantity_meters = r.cones_short,
           description     = 'Thread ' || r.color_code || ' - ' || r.cones_short
                             || ' cone(s), from ' || r.total_stitches || ' stitches'
     where purchase_order_id = v_po_id and color_code = r.color_code;

    if not found then
      insert into public.po_items
        (factory_id, purchase_order_id, color_code, quantity_meters, description)
      values
        (v_factory, v_po_id, r.color_code, r.cones_short,
         'Thread ' || r.color_code || ' - ' || r.cones_short
           || ' cone(s), from ' || r.total_stitches || ' stitches');
    end if;

    v_short := v_short + 1;
  end loop;

  return v_card;
end $$;

grant execute on function public.fm_ask_for_material(uuid) to authenticated;
