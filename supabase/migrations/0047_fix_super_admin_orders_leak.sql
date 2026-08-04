-- =============================================================================
-- Factory ERP — Close the super_admin -> orders read leak.
--
-- AUDIT (against the live project, via direct REST query as super@erp.test):
-- every other business table 0028 targeted correctly blocks super_admin
-- (vendors, machines, finishing_partners, invoices, payments, expenses, loans,
-- worker_ledger all returned []) — only `orders` did not; a plain
-- `orders?select=id` as super_admin returned every order across every factory.
--
-- ROOT CAUSE: `orders_select` (created by 0007's read-policy loop) was written
-- as `(factory scoped) OR is_super_admin()` — a blanket bypass, exactly the
-- pattern 0028's own header describes as the bug it was meant to close. 0028
-- closes it by re-wrapping whatever policy is LIVE at the moment it runs in
-- `(...) and not is_super_admin()`, which is correct algebra but only as
-- durable as the policy it wraps: if `orders_select` is ever recreated fresh
-- (0007 re-pasted, a manual policy edit, anything that reruns that DO block)
-- the `or is_super_admin()` bypass comes back and 0028's wrapper is gone with
-- it, because 0028 doesn't run again on its own.
--
-- FIX: stop wrapping. Redefine `orders_select` directly with no
-- is_super_admin() clause anywhere in it, matching how 0028 already prefers to
-- grant super_admin access explicitly and separately (see
-- thread_stock_super_admin_read / stock_movements_super_admin_read) rather
-- than folding it into an existing condition. There is nothing to wrap here —
-- super_admin gets nothing on `orders`, full stop — so there is no bypass
-- clause left for a future re-run of 0007 to reintroduce.
--
-- orders_insert / orders_update_draft / orders_delete_draft (0007) were
-- audited too: none of the three reference is_super_admin() — all three gate
-- on `has_any_role(['company_admin','order_taker'])`, which super_admin's role
-- never matches. Write access was already correctly zero; only SELECT leaked.
-- =============================================================================

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
  for select to authenticated
  using (
    factory_id = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
  );
