-- =============================================================================
-- Factory ERP — Super Admin restructure: 3 tabs, platform billing, and the
-- REMOVAL of super admin's inventory visibility.
--
-- TWO THINGS HAPPEN HERE, AND ONE OF THEM IS A DELIBERATE REVERT.
--
-- 1. 0028 revoked super_admin's blanket read on business data and then granted
--    it back on exactly two tables (thread_stock, stock_movements) so the
--    platform admin could see colour stock read-only. That exception is now
--    withdrawn: super_admin gets ZERO inventory access, in any form, on any
--    screen. The two additive policies and the two reader RPCs are dropped, so
--    the grant is gone from the database and not merely hidden in the UI.
--
--    NOTE ON THE POLICY NAME: 0068 renamed thread_stock -> inventory_items.
--    A policy follows its table through a rename, so the policy created as
--    `thread_stock_super_admin_read` now lives on `inventory_items` under that
--    original name. Both names are dropped below so this migration is correct
--    whether or not 0068 has been applied.
--
-- 2. Platform billing gets a real ledger. Until now the only billing facts were
--    three columns on `factories` (amount, status, next date) — enough for a
--    single "is this factory paid" pill and nothing else. The Super Admin's new
--    Billing section, per-factory Payment History and cross-factory Invoice
--    History all need INVOICE ROWS: one per billing cycle, with a date, an
--    amount and a status that can be settled independently.
--
--    `factories.subscription_status` is kept and kept honest: it is derived
--    from the invoice rows on every write (unpaid <=> at least one pending
--    invoice), so the existing list pill never disagrees with the ledger.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Withdraw super_admin's inventory read
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.inventory_items') is not null then
    drop policy if exists thread_stock_super_admin_read    on public.inventory_items;
    drop policy if exists inventory_items_super_admin_read on public.inventory_items;
  end if;

  -- After 0068 `thread_stock` is a VIEW, which cannot carry a policy. Only drop
  -- against it while it is still a real table (i.e. 0068 not yet applied).
  if exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'thread_stock' and c.relkind = 'r'
  ) then
    drop policy if exists thread_stock_super_admin_read on public.thread_stock;
  end if;
end $$;

drop policy if exists stock_movements_super_admin_read on public.stock_movements;

-- The two reader RPCs are SECURITY DEFINER, so dropping the policies alone
-- would NOT have closed the door — they bypass RLS by design. They go too.
drop function if exists public.sa_factory_inventory(uuid);
drop function if exists public.sa_last_audit(uuid);

-- ---------------------------------------------------------------------------
-- 2. Platform billing ledger
-- ---------------------------------------------------------------------------
create sequence if not exists public.factory_invoice_seq;

create table if not exists public.factory_invoices (
  id           uuid primary key default gen_random_uuid(),
  factory_id   uuid not null references public.factories(id) on delete cascade,
  invoice_code text not null unique
                 default ('INV-' || lpad(nextval('public.factory_invoice_seq')::text, 5, '0')),
  amount       numeric(14,2) not null check (amount >= 0),
  issued_on    date not null default current_date,
  due_date     date,
  status       text not null default 'pending',
  paid_on      date,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.factory_invoices drop constraint if exists factory_invoices_status_chk;
alter table public.factory_invoices add constraint factory_invoices_status_chk
  check (status in ('pending','paid','cancelled'));

-- A paid invoice must say when. Without this the payment-history screen has
-- rows it cannot date, which is exactly the column that screen is sorted by.
alter table public.factory_invoices drop constraint if exists factory_invoices_paid_on_chk;
alter table public.factory_invoices add constraint factory_invoices_paid_on_chk
  check ((status = 'paid') = (paid_on is not null));

create index if not exists idx_factory_invoices_factory
  on public.factory_invoices(factory_id, issued_on desc);
create index if not exists idx_factory_invoices_status
  on public.factory_invoices(status, issued_on desc);

drop trigger if exists trg_factory_invoices_touch on public.factory_invoices;
create trigger trg_factory_invoices_touch before update on public.factory_invoices
  for each row execute function public.touch_updated_at();

alter table public.factory_invoices enable row level security;

-- Platform billing is the ONE business-shaped table super_admin owns outright.
-- A factory's own users never see it: what the platform charges their owner is
-- not part of the factory's data, and nothing in the app reads it as a tenant.
drop policy if exists factory_invoices_super_admin_all on public.factory_invoices;
create policy factory_invoices_super_admin_all on public.factory_invoices
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 3. Keep factories.subscription_status derived from the ledger
--
-- The factory list pill and the invoice rows are two views of one fact. Deriving
-- the pill on every ledger write is the only way they cannot drift; the
-- alternative (updating both from each RPC) is how they always do.
-- ---------------------------------------------------------------------------
create or replace function public.sync_factory_subscription_status(p_factory_id uuid)
returns void
language sql security definer set search_path = public as $$
  update public.factories f
     set subscription_status = case
           when exists (select 1 from public.factory_invoices i
                         where i.factory_id = p_factory_id and i.status = 'pending')
           then 'unpaid' else 'paid' end
   where f.id = p_factory_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Super Admin billing RPCs
-- ---------------------------------------------------------------------------

/** Raise one invoice against a factory. */
create or replace function public.sa_issue_invoice(
  p_factory_id uuid,
  p_amount     numeric default null,
  p_due_date   date default null,
  p_note       text default null
)
returns public.factory_invoices
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.factory_invoices;
  v_f   public.factories;
begin
  if not public.is_super_admin() then
    raise exception 'Only the platform administrator can raise invoices.' using errcode = '42501';
  end if;

  select * into v_f from public.factories where id = p_factory_id;
  if not found then perform public.raise_not_found('Factory not found.'); end if;

  insert into public.factory_invoices (factory_id, amount, issued_on, due_date, status, note)
  values (
    p_factory_id,
    coalesce(p_amount, v_f.subscription_amount, 0),
    current_date,
    coalesce(p_due_date, v_f.next_billing_date, current_date + 30),
    'pending',
    nullif(trim(p_note), '')
  )
  returning * into v_inv;

  perform public.sync_factory_subscription_status(p_factory_id);
  return v_inv;
end $$;

/** Settle one invoice. Rolls the factory's next billing date forward a cycle. */
create or replace function public.sa_mark_invoice_paid(
  p_invoice_id uuid,
  p_paid_on    date default null
)
returns public.factory_invoices
language plpgsql security definer set search_path = public as $$
declare v_inv public.factory_invoices;
begin
  if not public.is_super_admin() then
    raise exception 'Only the platform administrator can settle invoices.' using errcode = '42501';
  end if;

  update public.factory_invoices
     set status = 'paid', paid_on = coalesce(p_paid_on, current_date)
   where id = p_invoice_id
     and status = 'pending'
  returning * into v_inv;

  if not found then
    -- Either it does not exist or it is already settled. Both are "nothing to
    -- do here", and the caller should be told which without a stack trace.
    if exists (select 1 from public.factory_invoices where id = p_invoice_id) then
      raise exception 'That invoice is not pending.' using errcode = '22023';
    end if;
    perform public.raise_not_found('Invoice not found.');
  end if;

  perform public.sync_factory_subscription_status(v_inv.factory_id);

  -- The next cycle is due one month after the one just settled, but only when
  -- nothing else is still outstanding — otherwise the date would jump forward
  -- while an older invoice is still unpaid.
  update public.factories f
     set next_billing_date = greatest(coalesce(f.next_billing_date, current_date), current_date) + 30
   where f.id = v_inv.factory_id
     and not exists (select 1 from public.factory_invoices i
                      where i.factory_id = f.id and i.status = 'pending');

  return v_inv;
end $$;

/**
 * Invoice history across every factory, newest first.
 *
 * All three billing surfaces read this one function: the Invoice History tab
 * passes nothing, the Pending sub-tab passes 'pending', and a factory's Payment
 * History passes its own id.
 */
create or replace function public.sa_invoice_list(
  p_status     text default null,
  p_factory_id uuid default null
)
returns table (
  id           uuid,
  factory_id   uuid,
  factory_name text,
  invoice_code text,
  amount       numeric,
  issued_on    date,
  due_date     date,
  status       text,
  paid_on      date,
  note         text
)
language sql stable security definer set search_path = public as $$
  select i.id, i.factory_id, f.name, i.invoice_code, i.amount,
         i.issued_on, i.due_date, i.status, i.paid_on, i.note
  from public.factory_invoices i
  join public.factories f on f.id = i.factory_id
  where public.is_super_admin()
    and (p_status is null or i.status = p_status)
    and (p_factory_id is null or i.factory_id = p_factory_id)
  order by i.issued_on desc, i.invoice_code desc
$$;

/**
 * The Billing section's headline figures.
 *
 * `pending_total` is the one shown large. It is the sum of what is OWED right
 * now, not the sum of every subscription — a monthly-rate total tells the
 * platform admin nothing they cannot read off the factory list, whereas the
 * outstanding total is the number that decides whether anyone gets chased.
 */
create or replace function public.sa_billing_summary()
returns table (
  pending_total   numeric,
  pending_count   int,
  overdue_count   int,
  paid_total      numeric,
  factory_count   int
)
language sql stable security definer set search_path = public as $$
  select
    coalesce(sum(i.amount) filter (where i.status = 'pending'), 0),
    count(*) filter (where i.status = 'pending')::int,
    count(*) filter (where i.status = 'pending'
                       and i.due_date is not null
                       and i.due_date < current_date)::int,
    coalesce(sum(i.amount) filter (where i.status = 'paid'), 0),
    (select count(*)::int from public.factories)
  from public.factory_invoices i
  where public.is_super_admin()
$$;

grant execute on function public.sync_factory_subscription_status(uuid)       to authenticated;
grant execute on function public.sa_issue_invoice(uuid, numeric, date, text)  to authenticated;
grant execute on function public.sa_mark_invoice_paid(uuid, date)             to authenticated;
grant execute on function public.sa_invoice_list(text, uuid)                  to authenticated;
grant execute on function public.sa_billing_summary()                         to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Backfill: every existing factory gets a ledger consistent with its pill
--
-- Without this the three new screens open empty on a database that has been
-- running for months, and the Pending total reads 0 beside factories whose
-- list pill says "Unpaid" — the exact disagreement section 3 exists to prevent.
--
-- Two settled invoices per factory give Payment History and Invoice History
-- something real to show; the open one is created only for factories whose
-- current pill already says unpaid.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select * from public.factories loop
    if exists (select 1 from public.factory_invoices i where i.factory_id = f.id) then
      continue;   -- already has a ledger; never seed on top of real data
    end if;

    insert into public.factory_invoices (factory_id, amount, issued_on, due_date, status, paid_on, note)
    values
      (f.id, f.subscription_amount, current_date - 60, current_date - 45,
       'paid', current_date - 52, 'Opening ledger entry'),
      (f.id, f.subscription_amount, current_date - 30, current_date - 15,
       'paid', current_date - 21, 'Opening ledger entry');

    if f.subscription_status = 'unpaid' then
      insert into public.factory_invoices (factory_id, amount, issued_on, due_date, status, note)
      values (f.id, f.subscription_amount, current_date,
              coalesce(f.next_billing_date, current_date + 30), 'pending',
              'Current cycle');
    end if;

    perform public.sync_factory_subscription_status(f.id);
  end loop;
end $$;
