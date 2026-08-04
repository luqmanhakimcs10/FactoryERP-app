-- Seed/cron setup for Phase 6 finishing stages & SLA alerts

-- 1. Enable pg_cron extension if available for automated SLA breach scanning
create extension if not exists pg_cron with schema extensions;

-- Schedule SLA breach scanner to run every 15 minutes
select cron.schedule(
  'check-sla-breaches-every-15m',
  '*/15 * * * *',
  $$ select public.check_sla_breaches(); $$
) where exists (select 1 from pg_extension where extname = 'pg_cron');
