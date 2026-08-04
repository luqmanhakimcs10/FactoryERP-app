-- =============================================================================
-- Factory ERP — reconcile the seeded thread stock with the ledger.
--
-- Why this is needed: 0009 seeded thread_stock with a direct INSERT (it predates
-- the stock_movements ledger). Those balances therefore have no movement behind
-- them, so a running sum of the ledger would not reconcile to the balance — and
-- "reconstruct the full history for a colour code" would be impossible for
-- exactly the colours the demo data uses.
--
-- This backfills one 'opening' movement per already-stocked colour and marks the
-- seeded factories as having completed their opening entry, which is the truth:
-- their stock exists, so the one-time entry must not be runnable again.
--
-- Idempotent: skips any colour that already has ledger history of any kind —
-- not just a movement literally typed 'opening'. Checking for that label
-- specifically was a latent bug: a colour created later via a real GRN
-- receipt has no 'opening' row (its first movement is 'grn'), so the old
-- check kept matching it on every re-run and inserting a second, spurious
-- opening movement on top of the real one — double-counting its balance in
-- the ledger sum. This backfill exists only for colours with NO history at
-- all (the original 0009 seed, before the ledger existed); anything with any
-- real movement already has a correct starting point and must be left alone.
-- =============================================================================

do $$
declare
  r record;
begin
  for r in
    select ts.id, ts.factory_id, ts.color_code, ts.quantity_meters
    from public.thread_stock ts
    where not exists (
      select 1 from public.stock_movements m
       where m.thread_stock_id = ts.id
    )
  loop
    insert into public.stock_movements
      (factory_id, thread_stock_id, color_code, movement_type, quantity_meters,
       balance_after, actor_user_id, ref_type, ref_id, note)
    values
      (r.factory_id, r.id, r.color_code, 'opening', r.quantity_meters,
       r.quantity_meters, null, 'opening', null,
       'Opening balance reconciled from deployment seed');
  end loop;
end $$;

-- Any factory that already holds stock has, by definition, had its opening entry.
update public.factories f
   set opening_stock_completed_at = coalesce(f.opening_stock_completed_at, now())
 where exists (select 1 from public.thread_stock ts where ts.factory_id = f.id);

-- Sanity check: every colour's ledger must now sum to its balance.
do $$
declare bad int;
begin
  select count(*) into bad
  from public.thread_stock ts
  where ts.quantity_meters <> (
    select coalesce(sum(m.quantity_meters), 0)
    from public.stock_movements m
    where m.thread_stock_id = ts.id
  );

  if bad > 0 then
    raise exception 'Ledger does not reconcile for % colour(s) — investigate before proceeding.', bad;
  end if;
end $$;
