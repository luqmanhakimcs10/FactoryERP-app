/**
 * The stage handover loop (migrations 0056/0057).
 *
 * One module for the whole cycle even though three roles touch it, because the
 * transitions only make sense as a sequence — splitting them across
 * orders.ts / finishing.ts by role is how the older, shorter loop ended up with
 * two half-implementations of the same idea.
 *
 * Every function here is a thin call onto a SECURITY DEFINER RPC. There is no
 * client-side status arithmetic on purpose: the database owns which transition
 * is legal from where, so a screen cannot invent a shortcut.
 */
import { supabase } from '../client';

/** The statuses a repeat moves through in one stage's cycle, in order. */
export type HandoverStatus =
  | 'in_progress'
  | 'stage_qa'
  | 'handover_for_delivery'
  | 'awaiting_dp_collection'
  | 'handed_over'
  | 'handed_off'
  | 'returned_to_delivery'
  | 'awaiting_fm_collection';

export interface DpOrderRow {
  repeat_id: string;
  repeat_code: string;
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  sheet_number: number | null;
  color_assignment: string | null;
  order_stage_id: string | null;
  stage_type: string | null;
  stage_sequence: number | null;
  total_stages: number;
  current_status: HandoverStatus;
  partner_id: string | null;
  partner_name: string | null;
  sla_hours: number | null;
  handed_off_at: string | null;
  sla_breached: boolean;
  /** When this piece last became the delivery person's problem — sorts the list. */
  arrived_at: string | null;
  /** Set once the finishing partner says their work is done. */
  partner_ready_at: string | null;
}

export interface PendingCollectionRow {
  repeat_id: string;
  repeat_code: string;
  order_id: string;
  order_code: string | null;
  stage_type: string | null;
  stage_sequence: number | null;
  partner_name: string | null;
}

export interface QaFinalRow {
  repeat_id: string;
  repeat_code: string;
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  sheet_number: number | null;
  color_assignment: string | null;
  sent_at: string | null;
}

// ---------------------------------------------------------------------------
// Floor Manager
// ---------------------------------------------------------------------------

/** Stage QA passed → release the piece to the Delivery Person. */
export async function handOverStage(repeatId: string) {
  const { data, error } = await supabase.rpc('fm_hand_over_stage', { p_repeat_id: repeatId });
  if (error) throw error;
  return data;
}

/**
 * Confirm the piece is physically back on the floor. This is what starts the
 * NEXT stage — there is no separate "start stage" call any more.
 */
export async function confirmCollection(repeatId: string) {
  const { data, error } = await supabase.rpc('fm_confirm_collection', { p_repeat_id: repeatId });
  if (error) throw error;
  return data;
}

/** Backs the "Collect [stage]" prompt. Pass an order id to scope it to one order. */
export async function listPendingCollections(orderId?: string | null): Promise<PendingCollectionRow[]> {
  const { data, error } = await supabase.rpc('fm_pending_collections', {
    p_order_id: orderId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as PendingCollectionRow[];
}

// ---------------------------------------------------------------------------
// Delivery Person — the single Orders tab
// ---------------------------------------------------------------------------

export async function listDeliveryOrders(): Promise<DpOrderRow[]> {
  const { data, error } = await supabase.rpc('dp_orders_queue');
  if (error) throw error;
  return (data ?? []) as DpOrderRow[];
}

/** Collect from the Floor Manager. Photo is required by the database, not just here. */
export async function collectFromFloor(repeatId: string, photoUrl: string) {
  const { data, error } = await supabase.rpc('dp_collect_from_floor', {
    p_repeat_id: repeatId,
    p_photo_url: photoUrl,
  });
  if (error) throw error;
  return data;
}

/** Send the piece out to the chosen handler. Starts the SLA clock. */
export async function sendToPartner(repeatId: string, partnerId: string) {
  const { data, error } = await supabase.rpc('dp_send_to_partner', {
    p_repeat_id: repeatId,
    p_partner_id: partnerId,
  });
  if (error) throw error;
  return data;
}

/** Collect back from the partner. Photo required; closes the SLA window. */
export async function collectFromPartner(repeatId: string, photoUrl: string) {
  const { data, error } = await supabase.rpc('dp_collect_from_partner', {
    p_repeat_id: repeatId,
    p_photo_url: photoUrl,
  });
  if (error) throw error;
  return data;
}

/** Hand back to the Floor Manager — raises their "Collect [stage]" prompt. */
export async function handBackToFloor(repeatId: string) {
  const { data, error } = await supabase.rpc('dp_hand_back_to_floor', { p_repeat_id: repeatId });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// QA — the second of the two final gates
// ---------------------------------------------------------------------------

export async function listQaFinalQueue(): Promise<QaFinalRow[]> {
  const { data, error } = await supabase.rpc('qa_final_queue');
  if (error) throw error;
  return (data ?? []) as QaFinalRow[];
}

/**
 * The pass that actually completes a repeat. QA only.
 *
 * The photo is required by the database, not just here: this is the last look
 * anyone takes at the piece before it is billed and delivered, so it is the
 * worst place in the app to have no record of what was approved.
 */
export async function qaFinalPass(repeatId: string, photoUrl: string, note?: string | null) {
  const { data, error } = await supabase.rpc('qa_final_pass', {
    p_repeat_id: repeatId,
    p_photo_url: photoUrl,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Machine assignment in one action (0057)
// ---------------------------------------------------------------------------

export async function assignMachineWithShift(params: {
  orderId: string;
  machineId: string;
  workerId: string;
  workerPhotoUrl: string;
  reportedStartTime?: string | null;
  openPhotoUrl?: string | null;
  openStitches?: number;
}): Promise<{ order_id: string; machine_id: string; shift_id: string; reused_shift: boolean }> {
  const { data, error } = await supabase.rpc('fm_assign_machine_with_shift', {
    p_order_id: params.orderId,
    p_machine_id: params.machineId,
    p_worker_id: params.workerId,
    p_worker_photo_url: params.workerPhotoUrl,
    p_reported_start_time: params.reportedStartTime ?? null,
    p_open_photo_url: params.openPhotoUrl ?? null,
    p_open_stitches: params.openStitches ?? 0,
  });
  if (error) throw error;
  return data as any;
}

// ---------------------------------------------------------------------------
// Finishing Partner — active work (0062)
// ---------------------------------------------------------------------------

export interface PartnerActiveWorkRow {
  repeat_id: string;
  repeat_code: string;
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  sheet_number: number | null;
  color_assignment: string | null;
  order_stage_id: string | null;
  stage_type: string | null;
  stage_sequence: number | null;
  total_stages: number;
  sla_hours: number | null;
  handed_off_at: string | null;
  sla_breached: boolean;
  partner_ready_at: string | null;
}

/** Everything currently handed to this partner and not yet returned. */
export async function listPartnerActiveWork(): Promise<PartnerActiveWorkRow[]> {
  const { data, error } = await supabase.rpc('partner_active_work');
  if (error) throw error;
  return (data ?? []) as PartnerActiveWorkRow[];
}

/**
 * "Handover to delivery person" — the partner signalling their work is done.
 * A flag for the delivery person, not a state change: custody only moves when
 * the delivery person actually collects (see 0062's header).
 */
export async function markPartnerReady(repeatId: string) {
  const { data, error } = await supabase.rpc('partner_ready_for_collection', {
    p_repeat_id: repeatId,
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Notification bell — what is waiting on me (0062)
// ---------------------------------------------------------------------------

export interface QueueSummaryRow {
  queue_key: string;
  label: string;
  count: number;
  /** Plain-language banner headline, e.g. "3 orders need a job card". */
  banner_title: string;
  banner_subtitle: string;
  /**
   * True only when the queue is this role's OWN job. company_admin counts every
   * role's queue for the bell (oversight), but only their approvals are theirs
   * to act on — banners render `own_task` rows so the owner is not buried under
   * nine act-now banners. See 0065.
   */
  own_task: boolean;
}

/** One row behind a banner. Shape is identical for every queue (0066). */
export interface QueueItem {
  item_id: string;
  code: string | null;
  title: string | null;
  subtitle: string | null;
  order_id: string | null;
  order_code: string | null;
  secondary_id: string | null;
  status: string | null;
}

/** The pending rows behind one banner — same predicate as its count. */
export async function getQueueItems(queueKey: string): Promise<QueueItem[]> {
  const { data, error } = await supabase.rpc('my_queue_items', { p_queue_key: queueKey });
  if (error) throw error;
  return (data ?? []) as QueueItem[];
}

/**
 * Counts pending work across the caller's own queues. Read-only, derived
 * entirely from the tables each role's dashboard already reads, so it cannot
 * drift from what the screens show.
 */
export async function getQueueSummary(): Promise<QueueSummaryRow[]> {
  const { data, error } = await supabase.rpc('my_queue_summary');
  if (error) throw error;
  return (data ?? []) as QueueSummaryRow[];
}

// ---------------------------------------------------------------------------
// Escape hatches (0063)
// ---------------------------------------------------------------------------

export interface StrandedOrderRow {
  order_id: string;
  order_code: string | null;
  order_status: string;
  stranded: number;
}

/**
 * Orders carrying repeats that can never move — coded, but left outside the
 * stage loop because their order advanced past `machine_selection_pending`
 * without them. Should always be empty now the second pipeline is retired.
 */
export async function listStrandedOrders(): Promise<StrandedOrderRow[]> {
  const { data, error } = await supabase.rpc('fm_stranded_repeat_orders');
  if (error) throw error;
  return (data ?? []) as StrandedOrderRow[];
}

/** Pull an order's stranded repeats into the loop at stage 1. */
export async function adoptStrandedRepeats(orderId: string) {
  const { data, error } = await supabase.rpc('fm_adopt_stranded_repeats', { p_order_id: orderId });
  if (error) throw error;
  return data as { order_id: string; repeats_adopted: number };
}

/**
 * Close a rejected piece's slot with no repeat behind it — for when the vendor
 * is never going to send it back. The damage record is left intact: this is an
 * admission the piece is gone, not a retraction of who lost it.
 */
export async function writeOffPiece(damageId: string, note?: string | null) {
  const { data, error } = await supabase.rpc('qa_write_off_piece', {
    p_damage_id: damageId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data;
}

/**
 * Cancel an order with nothing left to produce. Refused once any piece has
 * completed or the order has been invoiced.
 */
export async function cancelOrder(orderId: string, reason: string) {
  const { data, error } = await supabase.rpc('fm_cancel_order', {
    p_order_id: orderId,
    p_reason: reason,
  });
  if (error) throw error;
  return data;
}
