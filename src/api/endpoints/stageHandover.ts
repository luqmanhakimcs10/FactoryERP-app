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

/**
 * The statuses a repeat moves through in one stage's cycle, in order (0092).
 *
 * `awaiting_dp_collection` and `awaiting_fm_collection` were between
 * handover_for_delivery/handed_over and returned_to_delivery/stage_qa. Both
 * recorded a handover INSIDE the building as a state of its own, and both are
 * gone — the person carrying the piece records the move, once.
 */
export type HandoverStatus =
  | 'in_progress'
  | 'stage_qa'
  | 'handover_for_delivery'
  | 'handed_over'
  | 'handed_off'
  | 'returned_to_delivery';

/**
 * Where a row sits on the Delivery Person's screen (0092).
 *
 * Two of these are TABS — the two things this role does, drop off and pick up.
 * `completion` is a STATUS: pieces already delivered to the Inspector, shown
 * read-only so the last leg of the job does not simply vanish from the screen
 * of the person who did it.
 */
export type DeliveryTab = 'delivery' | 'pickup' | 'completion';

/** The two action tabs, in cycle order. `completion` is deliberately absent. */
export const DELIVERY_TABS: readonly DeliveryTab[] = ['delivery', 'pickup'] as const;

/**
 * Where a Delivery-tab piece is going. Decided in SQL from the status, not from
 * whether a partner name happens to be set — both legs of the round trip carry
 * a partner, and only the direction tells them apart.
 */
export type DeliveryDestination = 'partner' | 'qa';

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
  /**
   * Decided in SQL, not here. Which tab a status belongs to is part of the
   * workflow definition; a client that works it out for itself can file a piece
   * under a tab whose action the database will then refuse.
   */
  tab: DeliveryTab;
  /** Where this leg is headed — names the button without re-deriving it. */
  destination_kind: DeliveryDestination;
  partner_id: string | null;
  partner_name: string | null;
  /** The stage this trip is FOR — the one the Floor Manager's button named. */
  destination_stage: string | null;
  sla_hours: number | null;
  handed_off_at: string | null;
  sla_breached: boolean;
  /** When this piece last became the delivery person's problem — sorts the list. */
  arrived_at: string | null;
  /** Set once the finishing partner says their work is done. */
  partner_ready_at: string | null;
  /** Null on pieces handed over before 0084 — visible to every delivery person. */
  current_delivery_id: string | null;
}

// `PendingCollectionRow` was here — the shape of the Floor Manager's
// "Collect [stage]" prompt. Its RPC is dropped (0092) and nothing can reach the
// status it listed, so the type had no reader left.

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

export interface DeliveryPerson {
  id: string;
  display_name: string;
}

/** Who the Floor Manager can hand a stage to. */
export async function listDeliveryPeople(): Promise<DeliveryPerson[]> {
  const { data, error } = await supabase.rpc('fm_delivery_people');
  if (error) throw error;
  return (data ?? []) as DeliveryPerson[];
}

/**
 * Stage QA passed → release the piece, naming BOTH the courier and the handler
 * (0084). Picking one without the other was the old shape's problem: the
 * delivery person chose the finishing partner on their own, so a routing
 * decision about the order was made by whoever happened to pick the piece up.
 *
 * The partner is validated against the DESTINATION stage's type in the database,
 * so a partner who does not do that stage is refused here, not discovered later.
 */
export async function handOverStage(repeatId: string, deliveryId: string, partnerId: string) {
  const { data, error } = await supabase.rpc('fm_hand_over_stage', {
    p_repeat_id: repeatId,
    p_delivery_id: deliveryId,
    p_partner_id: partnerId,
  });
  if (error) throw error;
  return data;
}

// `confirmCollection` and `listPendingCollections` were here — the Floor
// Manager's "Collect [stage]" prompt and the press that answered it. 0092
// removed the state they both worked on: the delivery person now takes the
// piece to the Inspector, and that drop-off is what advances the stage. Both
// RPCs are dropped in the database too, so this is not a hidden capability —
// there is nothing left for them to act on.

// ---------------------------------------------------------------------------
// Delivery Person — Delivery / Pickup (0092)
//
// One query backs both tabs and the completion view: they are three views of
// one queue, and the row carries its own `tab`. The queue is SCOPED — a
// delivery person sees the pieces the Floor Manager assigned to them, plus any
// with no assignment at all (older rows, which would otherwise be invisible to
// everyone).
// ---------------------------------------------------------------------------

export async function listDeliveryOrders(): Promise<DpOrderRow[]> {
  const { data, error } = await supabase.rpc('dp_orders_queue');
  if (error) throw error;
  return (data ?? []) as DpOrderRow[];
}

// `collectFromFloor` was here. There is no collect-from-the-floor step any
// more: the Floor Manager's handover IS the collection, and the piece lands
// straight in the Delivery tab (0092).

/**
 * DELIVERY TAB, leg one — hand the piece to the finishing partner the Floor
 * Manager named. Photo required; starts the SLA clock.
 *
 * `partnerId` is a fallback, not a choice — the database uses it only when the
 * repeat carries no partner, which can only be a piece handed over by a
 * pre-0084 client. The tab shows a picker in exactly that case and no other.
 */
export async function handoverToPartner(
  repeatId: string,
  photoUrl: string,
  partnerId?: string | null
) {
  const { data, error } = await supabase.rpc('dp_handover_to_partner', {
    p_repeat_id: repeatId,
    p_photo_url: photoUrl,
    p_partner_id: partnerId ?? null,
  });
  if (error) throw error;
  return data;
}

/**
 * PICKUP TAB — collect back from the partner. Photo required; closes the SLA
 * window. Nothing on the partner's side has to happen first: they press no
 * button at all (0092), so this works from the moment the piece is out.
 */
export async function collectFromPartner(repeatId: string, photoUrl: string) {
  const { data, error } = await supabase.rpc('dp_collect_from_partner', {
    p_repeat_id: repeatId,
    p_photo_url: photoUrl,
  });
  if (error) throw error;
  return data;
}

/**
 * DELIVERY TAB, leg two — deliver the piece to the Inspector. Photo required.
 *
 * This is "Completion" from the delivery person's side, and it is also what
 * ADVANCES THE STAGE: the piece lands at Stage QA on the stage the partner did.
 * It replaces `handBackToFloor` + the Floor Manager's confirmation, which were
 * two presses recording one walk across the floor.
 */
export async function deliverToQa(repeatId: string, photoUrl: string) {
  const { data, error } = await supabase.rpc('dp_deliver_to_qa', {
    p_repeat_id: repeatId,
    p_photo_url: photoUrl,
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Final QA
//
// `listQaFinalQueue` and `qaFinalPass` were here — the second of what used to
// be two final gates. Final QA is the Floor Manager's step now and QA has no
// part in it (0087), so both RPCs were dropped rather than left callable: a
// SECURITY DEFINER function that completes a repeat is not something to leave
// on the REST surface after deciding the role that calls it should not do this.
//
// `QaFinalRow` below is kept — the Floor Manager's queue has the same shape.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Machine assignment (0084)
//
// `assignMachineWithShift` lived here. It fused the routing decision ("this
// order runs on machine 3") with a payroll record ("Asha is on machine 3 from
// 08:00") and made the first impossible without the second. 0084 drops the RPC;
// assignment is `assignMachine` below, and shifts are opened from the Shift
// screens as their own independent flow.
// ---------------------------------------------------------------------------

/** Record which machine an order runs on. No shift, no worker, no photo. */
export async function assignMachine(orderId: string, machineId: string) {
  const { data, error } = await supabase.rpc('fm_assign_machine', {
    p_order_id: orderId,
    p_machine_id: machineId,
  });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// The journey summary behind Final QA (0084)
// ---------------------------------------------------------------------------

export interface JourneyRow {
  history_id: string;
  repeat_id: string;
  repeat_code: string;
  stage_sequence: number | null;
  stage_type: string | null;
  status: string;
  note: string | null;
  actor_name: string | null;
  actor_role: string | null;
  partner_name: string | null;
  photo_url: string | null;
  return_photo_url: string | null;
  handed_off_at: string | null;
  returned_at: string | null;
  created_at: string;
}

/**
 * Every recorded event for every repeat on an order, oldest first per repeat.
 *
 * This is a read over `repeat_stage_history`, which has held all of it since
 * Phase 3 — nothing new is written for the summary. It was simply only
 * reachable one repeat at a time, through a collapsed panel.
 */
export async function getOrderJourney(orderId: string): Promise<JourneyRow[]> {
  const { data, error } = await supabase.rpc('fm_order_journey', { p_order_id: orderId });
  if (error) throw error;
  return (data ?? []) as JourneyRow[];
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

// `markPartnerReady` was here — "Handover to delivery person". 0062 made it a
// signal rather than a gate; 0092 removes it entirely, because a signal a
// partner has to remember to send is still something the next person waits on.
// `partner_ready_for_collection` remains in the database and gates nothing, so
// nothing is stranded by its wrapper going.

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

// `writeOffPiece` was here. The "Write off" control is gone from QA's reject
// flow (0087), so it had no caller left. `qa_write_off_piece` is deliberately
// STILL IN THE DATABASE: it is the only thing that can close a rejected piece
// the vendor never sends back, and dropping it would destroy that capability
// along with the button. Re-add this wrapper if the escape is given to another
// role.

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
