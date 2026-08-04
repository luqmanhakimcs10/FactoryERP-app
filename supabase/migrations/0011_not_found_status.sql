-- =============================================================================
-- Factory ERP — return a proper 404 instead of a 500 for "not found".
--
-- Why: assert_my_order() raises errcode P0002 for both a missing order and one
-- belonging to another factory (deliberately indistinguishable, so we never
-- confirm another tenant's row exists). PostgREST does not map P0002 to a status,
-- so the client saw HTTP 500 — which reads as "the server is broken" and would
-- surface as a generic error in the UI.
--
-- PostgREST lets a function set the response status by raising the special
-- 'PGRST' sqlstate with a JSON detail. Security is unchanged; only the status
-- code and client experience improve.
-- =============================================================================

create or replace function public.raise_not_found(p_message text)
returns void
language plpgsql as $$
begin
  raise sqlstate 'PGRST' using
    message = json_build_object(
      'code', 'PGRST116',
      'message', p_message,
      'details', null,
      'hint', null
    )::text,
    -- PostgREST requires BOTH 'status' and 'headers' in DETAIL; omitting
    -- 'headers' yields PGRST121 and a 500, defeating the purpose.
    detail = json_build_object('status', 404, 'headers', json_build_object())::text;
end $$;

create or replace function public.assert_my_order(p_order_id uuid)
returns public.orders
language plpgsql stable security definer set search_path = public as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id;

  -- Missing and cross-tenant produce the SAME response on purpose: a different
  -- error for "exists but not yours" would leak the existence of another
  -- factory's orders to anyone probing ids.
  if not found or o.factory_id is distinct from public.current_factory_id() then
    perform public.raise_not_found('Order not found.');
  end if;

  return o;
end $$;

create or replace function public.log_repeat_stage(
  p_repeat_id      uuid,
  p_status         text,
  p_order_stage_id uuid default null,
  p_photo_url      text default null,
  p_note           text default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_factory uuid;
  v_id      uuid;
begin
  select factory_id into v_factory from public.repeats where id = p_repeat_id;

  if v_factory is null or v_factory is distinct from public.current_factory_id() then
    perform public.raise_not_found('Repeat not found.');
  end if;

  -- 1. Source of truth: append-only history.
  insert into public.repeat_stage_history
    (factory_id, repeat_id, order_stage_id, status, actor_user_id, photo_url, note)
  values
    (v_factory, p_repeat_id, p_order_stage_id, p_status, auth.uid(), p_photo_url, p_note)
  returning id into v_id;

  -- 2. Denormalized cache, same transaction so it cannot drift.
  update public.repeats
     set current_status = p_status,
         updated_at = now()
   where id = p_repeat_id;

  return v_id;
end $$;

grant execute on function public.raise_not_found(text) to authenticated;
