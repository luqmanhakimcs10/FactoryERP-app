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
on conflict (factory_id, color_code) do nothing;
