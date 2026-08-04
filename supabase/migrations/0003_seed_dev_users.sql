-- =============================================================================
-- Factory ERP — Phase 1 DEV seed: test auth users + their profiles.
--
-- !!! DEVELOPMENT / DUMMY-TENANT USE ONLY. Never run against production. !!!
--
-- Creates one login per role in BOTH dummy factories, plus a super admin,
-- so role routing and cross-tenant isolation can be tested end to end.
-- All passwords: Password123!
--
--   Super admin:  super@erp.test
--   Alpha (factory 1111...):  <role>@alpha.test   e.g. owner@alpha.test, floor@alpha.test
--   Beta  (factory 2222...):  <role>@beta.test    e.g. owner@beta.test,  worker@beta.test
--
-- Run AFTER 0001 and 0002. Idempotent (skips auth users that already exist).
--
-- If your project's GoTrue/auth schema rejects these inserts, use the Dashboard
-- fallback instead: Authentication -> Users -> Add user for each email above,
-- then run 0003b_seed_profiles_by_email.sql to attach profiles.
-- =============================================================================

create extension if not exists pgcrypto;

do $$
declare
  r    record;
  uid  uuid;
begin
  for r in
    select * from (values
      -- email,                 factory_id,                                     role,               display_name
      ('super@erp.test',        null::uuid,                                     'super_admin',      'Platform Admin'),

      ('owner@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'company_admin',    'Alpha Owner'),
      ('accountant@alpha.test', '11111111-1111-1111-1111-111111111111'::uuid,  'accountant',       'Alpha Accountant'),
      ('floor@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'floor_manager',    'Alpha Floor Mgr'),
      ('store@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'store_manager',    'Alpha Store Mgr'),
      ('order@alpha.test',      '11111111-1111-1111-1111-111111111111'::uuid,  'order_taker',      'Alpha Order Taker'),
      ('qa@alpha.test',         '11111111-1111-1111-1111-111111111111'::uuid,  'qa',               'Alpha QA'),
      ('procurement@alpha.test','11111111-1111-1111-1111-111111111111'::uuid,  'procurement',      'Alpha Procurement'),
      ('delivery@alpha.test',   '11111111-1111-1111-1111-111111111111'::uuid,  'delivery',         'Alpha Delivery'),
      ('worker@alpha.test',     '11111111-1111-1111-1111-111111111111'::uuid,  'worker',           'Alpha Worker'),
      ('partner@alpha.test',    '11111111-1111-1111-1111-111111111111'::uuid,  'finishing_partner','Alpha Partner'),

      ('owner@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'company_admin',    'Beta Owner'),
      ('accountant@beta.test',  '22222222-2222-2222-2222-222222222222'::uuid,  'accountant',       'Beta Accountant'),
      ('floor@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'floor_manager',    'Beta Floor Mgr'),
      ('store@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'store_manager',    'Beta Store Mgr'),
      ('order@beta.test',       '22222222-2222-2222-2222-222222222222'::uuid,  'order_taker',      'Beta Order Taker'),
      ('qa@beta.test',          '22222222-2222-2222-2222-222222222222'::uuid,  'qa',               'Beta QA'),
      ('procurement@beta.test', '22222222-2222-2222-2222-222222222222'::uuid,  'procurement',      'Beta Procurement'),
      ('delivery@beta.test',    '22222222-2222-2222-2222-222222222222'::uuid,  'delivery',         'Beta Delivery'),
      ('worker@beta.test',      '22222222-2222-2222-2222-222222222222'::uuid,  'worker',           'Beta Worker'),
      ('partner@beta.test',     '22222222-2222-2222-2222-222222222222'::uuid,  'finishing_partner','Beta Partner')
    ) as t(email, factory_id, role, display_name)
  loop
    select id into uid from auth.users where email = r.email;

    if uid is null then
      uid := gen_random_uuid();

      -- The token columns MUST be '' and never NULL: GoTrue scans them into
      -- non-nullable Go strings, and a NULL breaks every login with
      -- "Database error querying schema" (500). See 0004 for the repair.
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data, is_super_admin,
        confirmation_token, recovery_token,
        email_change_token_new, email_change_token_current, email_change,
        phone_change, phone_change_token, reauthentication_token
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
        r.email, crypt('Password123!', gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false,
        '', '', '', '', '', '', '', ''
      );

      insert into auth.identities (
        provider_id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values (
        uid::text, uid,
        jsonb_build_object('sub', uid::text, 'email', r.email),
        'email', now(), now(), now()
      );
    end if;

    insert into public.profiles (id, factory_id, role, display_name)
    values (uid, r.factory_id, r.role, r.display_name)
    on conflict (id) do update
      set factory_id = excluded.factory_id,
          role = excluded.role,
          display_name = excluded.display_name;
  end loop;
end $$;
