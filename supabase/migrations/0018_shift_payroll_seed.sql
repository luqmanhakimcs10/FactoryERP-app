-- Allow shift panel photos in order-photos bucket for machine_workforce module.
drop policy if exists order_photos_insert on storage.objects;
create policy order_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-photos'
    and public.storage_object_factory(name) = public.current_factory_id()
    and (
      public.module_enabled('order_lifecycle')
      or public.module_enabled('machine_workforce')
    )
  );

-- Seed Alpha machines + worker rates + bonus slabs (Alpha has machine_workforce on).
insert into public.machines (id, factory_id, name, managed_by)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, 'M-01',
   (select id from public.profiles where display_name = 'Alpha Floor Mgr' limit 1)),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002'::uuid, '11111111-1111-1111-1111-111111111111'::uuid, 'M-02',
   (select id from public.profiles where display_name = 'Alpha Floor Mgr' limit 1))
on conflict (id) do update set managed_by = excluded.managed_by;

update public.profiles
   set stitch_rate = 0.05
 where display_name = 'Alpha Worker'
   and factory_id = '11111111-1111-1111-1111-111111111111'::uuid;

insert into public.bonus_slabs (factory_id, daily_stitch_threshold, bonus_amount)
values
  ('11111111-1111-1111-1111-111111111111'::uuid, 5000, 200),
  ('11111111-1111-1111-1111-111111111111'::uuid, 10000, 500)
on conflict do nothing;

-- Beta: one machine for tenancy tests (Beta has machine_workforce OFF by default —
-- RLS will block; enable in tests if needed).
insert into public.machines (id, factory_id, name, managed_by)
select
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid,
  'M-B01',
  (select id from public.profiles where display_name = 'Beta Floor Mgr' limit 1)
where not exists (
  select 1 from public.machines where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb0001'::uuid
);

update public.profiles
   set stitch_rate = 0.04
 where display_name = 'Beta Worker'
   and factory_id = '22222222-2222-2222-2222-222222222222'::uuid;
