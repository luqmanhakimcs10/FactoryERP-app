-- =============================================================================
-- Factory ERP — fix: 0072 quietly broke the legacy weekly audit.
--
-- WHAT I MISSED IN 0072
-- --------------------
-- 0072 added `stock_audits.audit_type` with `default 'daily'`, and a unique index
-- allowing one 'daily' audit per factory per day. Both are right for the new
-- flow, and together they broke the old one.
--
-- `sm_submit_audit` (0013, the colour-keyed weekly RPC) does not name
-- audit_type, so every row it writes takes the default and is labelled 'daily'.
-- That is wrong twice:
--
--   1. It is a lie in the history list — the Audit tab shows those rows as daily
--      audits that nobody performed through the daily walk.
--   2. It collides with uq_daily_audit_per_day. A second weekly audit on the
--      same date now fails on a uniqueness rule that was never meant to apply
--      to it. The tenancy suite's ledger sections depend on that audit landing,
--      so an audit_variance movement stopped being written and the whole
--      RED-01 trail reconstruction failed with it — a long way from the
--      audit_type column, and nothing pointing back to it.
--
-- 0072's own header says sm_submit_audit was left in place deliberately, because
-- "deleting a working function in the same migration that introduces its
-- replacement is how a rollback becomes impossible". That reasoning was right and
-- I then broke the function anyway, by giving a new column a default that only
-- suits the new caller.
--
-- THE FIX: FLIP THE DEFAULT
-- -------------------------
-- `sm_submit_daily_audit` always passes 'daily' explicitly, so it does not need
-- the default. Nothing else writes stock_audits except the legacy RPC, which
-- cannot pass anything. So the default belongs to the legacy path:
--
--   default 'weekly'  -> the legacy RPC lands truthfully and cannot collide
--                        with the daily rule
--   explicit 'daily'  -> only the daily walk, which is the only thing that IS one
--
-- This is preferred over rewriting sm_submit_audit for the same reason 0072 kept
-- it: the less that function is touched, the more certain it stays that the old
-- flow still works. A column default is also the narrower change — it cannot
-- affect any row that names its own value.
--
-- Rows already mislabelled by this are repaired below, using the same derived
-- rule 0072 uses for the historic backfill: only the daily walk ever writes
-- `marked_correct`, so an audit with no marked item was not a daily audit,
-- whatever its label says.
-- =============================================================================

alter table public.stock_audits alter column audit_type set default 'weekly';

comment on column public.stock_audits.audit_type is
  'daily = written by sm_submit_daily_audit, which always sets it explicitly. '
  'weekly = the DEFAULT, so the legacy colour-keyed sm_submit_audit lands here '
  'and never collides with uq_daily_audit_per_day.';

-- Repair anything the 'daily' default already mislabelled. Derived, not dated,
-- so re-running this file is safe.
update public.stock_audits sa
   set audit_type = 'weekly'
 where sa.audit_type = 'daily'
   and not exists (
     select 1 from public.stock_audit_items i
      where i.stock_audit_id = sa.id
        and i.marked_correct is not null
   );
