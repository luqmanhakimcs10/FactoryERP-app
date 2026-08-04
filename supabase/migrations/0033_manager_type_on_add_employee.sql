-- =============================================================================
-- Factory ERP — Manager type on the Add Employee flow
--
-- The Owner's "Manager" role picker now asks floor manager vs store manager
-- before submitting, because plain `manager` has no navigator of its own
-- (createRoleNavigator's homeFor() falls through to the generic placeholder
-- shell for it) — an employee created with that role landed on a dead end.
-- floor_manager and store_manager already have full navigators, screens and
-- RLS scoping (Phases 4/5); they just weren't reachable from create_employee.
--
-- roles.key already has both (0002 seed), and employee_compensation.role is a
-- bare FK to roles.key with no extra CHECK, so the only gate to widen is the
-- explicit allow-list inside create_employee itself.
-- =============================================================================

create or replace function public.create_employee(
  p_email         text,
  p_password      text,
  p_display_name  text,
  p_role          text,
  p_salary_type   text,
  p_salary_amount numeric
)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_factory uuid := public.current_factory_id();
  v_user_id uuid;
  v_email   text := lower(trim(p_email));
begin
  perform public.assert_role(array['company_admin']);

  if p_role not in (
    'worker','manager','qa','labour','delivery','order_taker',
    'floor_manager','store_manager'
  ) then
    raise exception 'Role % is not an employee role.', p_role using errcode = '22023';
  end if;
  if p_salary_type not in ('per_month','per_day','per_stitch') then
    raise exception 'Invalid salary type.' using errcode = '22023';
  end if;
  if p_salary_amount < 0 then
    raise exception 'Salary amount cannot be negative.' using errcode = '22023';
  end if;
  if v_email = '' or coalesce(trim(p_password), '') = '' or char_length(p_password) < 8 then
    raise exception 'An email and a password of at least 8 characters are required.' using errcode = '22023';
  end if;
  if p_display_name is null or trim(p_display_name) = '' then
    raise exception 'Display name is required.' using errcode = '22023';
  end if;

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data, is_super_admin,
      confirmation_token, recovery_token,
      email_change_token_new, email_change_token_current, email_change,
      phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
      v_email, crypt(p_password, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false,
      '', '', '', '', '', '', '', ''
    )
    returning id into v_user_id;

    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_user_id::text, v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email),
      'email', now(), now(), now()
    );
  exception
    when unique_violation then
      raise exception 'An account with that email already exists.' using errcode = '23505';
  end;

  insert into public.profiles (id, factory_id, role, display_name)
  values (v_user_id, v_factory, p_role, trim(p_display_name));

  insert into public.employee_compensation (factory_id, user_id, role, salary_type, salary_amount)
  values (v_factory, v_user_id, p_role, p_salary_type, p_salary_amount);

  -- Piece-rate workers need their rate on the profile too: shift close
  -- snapshots profiles.stitch_rate into worker_ledger.base_per_stitch.
  if p_salary_type = 'per_stitch' then
    update public.profiles set stitch_rate = p_salary_amount where id = v_user_id;
  end if;

  return jsonb_build_object('id', v_user_id, 'email', v_email);
end $$;
