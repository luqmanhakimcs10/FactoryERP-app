-- =============================================================================
-- Factory ERP — dev seed: opening thread stock.
--
-- Deliberately uneven so BOTH branches of the submit-time inventory check can be
-- exercised inside a single factory:
--   * stocked colours (RED-01, GLD-02, BLK-03, WHT-04) -> sufficient
--     -> order goes to 'awaiting_cloth_inspection'
--   * any other colour, e.g. NEO-99                    -> shortfall
--     -> order goes to 'awaiting_procurement' + auto-PO
--
-- Beta is stocked more thinly than Alpha so the two tenants differ visibly.
-- =============================================================================

insert into public.thread_stock (factory_id, color_code, quantity_meters)
values
  -- Alpha: comfortable stock
  ('11111111-1111-1111-1111-111111111111', 'RED-01', 500000),
  ('11111111-1111-1111-1111-111111111111', 'GLD-02', 500000),
  ('11111111-1111-1111-1111-111111111111', 'BLK-03', 500000),
  ('11111111-1111-1111-1111-111111111111', 'WHT-04', 500000),
  -- Beta: thinner, but enough for a small order
  ('22222222-2222-2222-2222-222222222222', 'RED-01', 120000),
  ('22222222-2222-2222-2222-222222222222', 'GLD-02', 120000),
  ('22222222-2222-2222-2222-222222222222', 'BLK-03', 120000)
-- do nothing, not do update: this is a one-time seed. Once a colour has real
-- ledger activity (GRNs, issues, audits — see stock_movements), overwriting
-- its balance here would silently erase that history from the balance while
-- leaving the ledger itself intact, exactly what happened when this file was
-- accidentally re-applied against a live database.
--
-- NO CONFLICT TARGET, deliberately. This used to name `(factory_id,
-- color_code)`, which was the unique constraint until 0068 replaced it: colour
-- alone no longer identifies a row now that a red thread and a red tilla both
-- exist, so the new index includes item_type and the sequin attributes. A named
-- target has to match an index exactly, so this file failed with 42P10 against
-- any database that had run 0068.
--
-- Bare DO NOTHING needs no inference at all, so it is correct on BOTH schemas:
-- the pre-0068 table and the post-0068 view. That is what a seed wants anyway —
-- "skip anything already there", whatever makes it a duplicate.
on conflict do nothing;
