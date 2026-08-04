-- =============================================================================
-- Factory ERP — Storage bucket for order photos (cloth photos, design sheets,
-- and later damage/handoff proof).
--
-- Tenant isolation extends to files, not just rows. The path convention is
--     <factory_id>/<order_id>/<filename>
-- and the policies below compare the FIRST path segment to the caller's own
-- factory_id, so a user cannot read or write another factory's objects even with
-- a guessed URL. The bucket is private; clients fetch via signed URLs.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('order-photos', 'order-photos', false)
on conflict (id) do update set public = false;

-- Helper: the factory that owns an object, from its path prefix.
create or replace function public.storage_object_factory(p_name text)
returns uuid
language plpgsql immutable as $$
begin
  -- Invalid/short paths yield NULL, which fails every policy comparison.
  return (storage.foldername(p_name))[1]::uuid;
exception when others then
  return null;
end $$;

drop policy if exists order_photos_select on storage.objects;
create policy order_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-photos'
    and public.storage_object_factory(name) = public.current_factory_id()
  );

drop policy if exists order_photos_insert on storage.objects;
create policy order_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-photos'
    and public.storage_object_factory(name) = public.current_factory_id()
    and public.module_enabled('order_lifecycle')
  );

drop policy if exists order_photos_update on storage.objects;
create policy order_photos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'order-photos'
    and public.storage_object_factory(name) = public.current_factory_id()
  )
  with check (
    bucket_id = 'order-photos'
    and public.storage_object_factory(name) = public.current_factory_id()
  );

-- Deletion is restricted: photos are evidence (damage claims, custody proof).
drop policy if exists order_photos_delete on storage.objects;
create policy order_photos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'order-photos'
    and public.storage_object_factory(name) = public.current_factory_id()
    and public.has_any_role(array['company_admin'])
  );
