-- =============================================================================
-- Factory ERP — Repeats & Stage Tracking: schema foundation (Stage 9).
--
-- Landed ahead of Stage 8's "Start production" (0044) because that RPC hands
-- repeats off into the first status this migration defines.
--
-- This loop is a NEW, independent pipeline — deliberately not layered onto the
-- Phase 6 handoff/collection-QA mechanism. `assert_stage_access()` (0020) only
-- lets a Floor Manager onto an in-house stage when `order_stages.handler_user_id
-- = auth.uid()`, a field the Job Card Builder UI never sets; reusing that path
-- would refuse every Floor Manager on every in-house stage. Phase 6 keeps
-- serving outsourced-partner stages via Delivery Person exactly as today.
--
-- `current_stage_index` is 1-based, matching `order_stages.sequence` (which
-- itself starts at 1, see 0007). It tracks which stage in the order's own
-- sequence a repeat is currently working through.
-- =============================================================================

alter table public.repeats
  add column if not exists current_stage_index int not null default 0;

alter table public.repeats drop constraint if exists repeats_current_status_check;
alter table public.repeats add constraint repeats_current_status_check
  check (current_status in (
    'coded',
    'awaiting_job_card',
    'ready_for_production',
    'awaiting_stage',
    'in_progress',
    'stage_qa',
    'in_production',
    'in_finishing',
    'handed_off',
    'awaiting_collection_qa',
    'awaiting_final_qa',
    'completed',
    'damaged'
  ));
