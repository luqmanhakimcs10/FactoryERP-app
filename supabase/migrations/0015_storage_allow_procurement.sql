-- =============================================================================
-- Factory ERP — let procurement upload supplier bills.
--
-- The Phase 3 insert policy on order-photos required module_enabled
-- ('order_lifecycle'), which is right for cloth photos but blocks supplier bills:
-- those belong to Inventory & Procurement. A factory with procurement enabled and
-- order lifecycle disabled could not attach a bill at all.
--
-- Tenant isolation is unchanged — the first path segment must still be the
-- caller's own factory_id.
-- =============================================================================

drop policy if exists order_photos_insert on storage.objects;
create policy order_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-photos'
    and public.storage_object_factory(name) = public.current_factory_id()
    and (
      public.module_enabled('order_lifecycle')
      or public.module_enabled('inventory_procurement')
    )
  );
