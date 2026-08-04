/**
 * Order-spine API.
 *
 * All state transitions go through the Postgres RPCs from migration 0008 — never
 * a direct table write. That is what guarantees `repeat_stage_history` (the source
 * of truth) is appended to on every move, with `repeats.current_status` refreshed
 * in the same transaction. A screen that "just updated the status" would break
 * every later phase's ability to query where a repeat has been.
 */
import { supabase } from '../client';
import type {
  Order,
  OrderStage,
  Sheet,
  Repeat,
  RepeatStageHistory,
  JobCard,
  JobCardLine,
  DamageRecord,
  PurchaseOrder,
  TimelineStep,
  SheetInput,
  StageInput,
  SubmitResult,
  OrderListRow,
  DamageType,
} from '../../models/orderTypes';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Orders for the caller's factory, with vendor name and repeat/sheet counts. */
export async function listOrders(statuses?: string[]): Promise<OrderListRow[]> {
  let q = supabase
    .from('orders')
    .select('*, vendors(name), sheets(repeats_count)')
    .order('created_at', { ascending: false });

  if (statuses?.length) q = q.in('status', statuses);

  const { data, error } = await q;
  if (error) throw error;

  return (data ?? []).map((o: any) => ({
    ...o,
    vendor_name: o.vendors?.name ?? '—',
    sheet_count: o.sheets?.length ?? 0,
    repeat_total: (o.sheets ?? []).reduce(
      (sum: number, s: any) => sum + (s.repeats_count ?? 0),
      0
    ),
  })) as OrderListRow[];
}

export async function getOrder(orderId: string): Promise<Order | null> {
  const { data, error } = await supabase
    .from('orders')
    .select('*, vendors(name, contact, address)')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  return (data as any) ?? null;
}

export async function listSheets(orderId: string): Promise<Sheet[]> {
  const { data, error } = await supabase
    .from('sheets')
    .select('*')
    .eq('order_id', orderId)
    .order('sheet_number');
  if (error) throw error;
  return (data ?? []) as Sheet[];
}

export async function listOrderStages(orderId: string): Promise<OrderStage[]> {
  const { data, error } = await supabase
    .from('order_stages')
    .select('*, finishing_partners(name)')
    .eq('order_id', orderId)
    .order('sequence');
  if (error) throw error;
  return (data ?? []) as any;
}

/** Repeats for an order, joined through sheets. */
export async function listRepeats(orderId: string): Promise<Repeat[]> {
  const { data, error } = await supabase
    .from('repeats')
    .select('*, sheets!inner(order_id, sheet_number, color_assignment)')
    .eq('sheets.order_id', orderId)
    .order('repeat_code');
  if (error) throw error;
  return (data ?? []) as any;
}

/**
 * A repeat's full stage history — the audit trail later phases read.
 * Newest first.
 */
export async function listRepeatHistory(repeatId: string): Promise<RepeatStageHistory[]> {
  const { data, error } = await supabase
    .from('repeat_stage_history')
    .select('*, profiles(display_name), order_stages(stage_type, sequence)')
    .eq('repeat_id', repeatId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

export async function getJobCard(
  orderId: string
): Promise<{ card: JobCard | null; lines: JobCardLine[] }> {
  const { data: card, error } = await supabase
    .from('job_cards')
    .select('*')
    .eq('order_id', orderId)
    .maybeSingle();
  if (error) throw error;
  if (!card) return { card: null, lines: [] };

  const { data: lines, error: lineErr } = await supabase
    .from('job_card_lines')
    .select('*')
    .eq('job_card_id', (card as JobCard).id)
    .order('needle_number');
  if (lineErr) throw lineErr;

  return { card: card as JobCard, lines: (lines ?? []) as JobCardLine[] };
}

export async function listOrderDamage(orderId: string): Promise<DamageRecord[]> {
  const { data, error } = await supabase
    .from('damage_records')
    .select('*, sheets(sheet_number, color_assignment), repeats(repeat_code)')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

/** Every damage record in the factory — floor manager's Damages box. */
export async function listFactoryDamage(): Promise<DamageRecord[]> {
  const { data, error } = await supabase
    .from('damage_records')
    .select('*, orders(order_code), sheets(sheet_number, color_assignment), repeats(repeat_code)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

export async function listOrderPurchaseOrders(orderId: string): Promise<PurchaseOrder[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, po_items(color_code, quantity_meters)')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

/** Lifecycle timeline, computed from repeat_stage_history + order_stages. */
export async function getOrderTimeline(orderId: string): Promise<TimelineStep[]> {
  const { data, error } = await supabase.rpc('order_timeline', { p_order_id: orderId });
  if (error) throw error;
  return (data ?? []) as TimelineStep[];
}

/** Thread requirement per colour — shown on the review step before submit. */
export async function getThreadRequirements(
  orderId: string
): Promise<{ color_code: string; required_meters: number }[]> {
  const { data, error } = await supabase.rpc('order_thread_requirements', {
    p_order_id: orderId,
  });
  if (error) throw error;
  return (data ?? []) as any;
}

// ---------------------------------------------------------------------------
// Transitions (RPC only)
// ---------------------------------------------------------------------------

export async function createOrder(args: {
  vendorId: string;
  sheets: SheetInput[];
  clothPhotos?: string[];
  designSheetUrl?: string | null;
}): Promise<Order> {
  const { data, error } = await supabase.rpc('create_order', {
    p_vendor_id: args.vendorId,
    p_sheets: args.sheets,
    p_cloth_photos: args.clothPhotos ?? [],
    p_design_sheet_url: args.designSheetUrl ?? null,
  });
  if (error) throw error;
  return data as Order;
}

/** Runs the thread/inventory check and branches the order's status. */
export async function submitOrder(orderId: string): Promise<SubmitResult> {
  const { data, error } = await supabase.rpc('submit_order', { p_order_id: orderId });
  if (error) throw error;
  return data as SubmitResult;
}

export async function updateOrderPhotos(
  orderId: string,
  clothPhotos: string[],
  designSheetUrl?: string | null
): Promise<void> {
  const patch: Record<string, unknown> = { cloth_photos: clothPhotos };
  if (designSheetUrl !== undefined) patch.design_sheet_url = designSheetUrl;

  const { error } = await supabase.from('orders').update(patch).eq('id', orderId);
  if (error) throw error;
}

// ---- QA ----

export async function reportClothDamage(args: {
  orderId: string;
  damageType: string;
  sheetId?: string | null;
  photoUrl?: string | null;
  note?: string | null;
}): Promise<DamageRecord> {
  const { data, error } = await supabase.rpc('qa_report_cloth_damage', {
    p_order_id: args.orderId,
    p_damage_type: args.damageType,
    p_sheet_id: args.sheetId ?? null,
    p_photo_url: args.photoUrl ?? null,
    p_note: args.note ?? null,
  });
  if (error) throw error;
  return data as DamageRecord;
}

export async function acceptCloth(orderId: string): Promise<Order> {
  const { data, error } = await supabase.rpc('qa_accept_cloth', { p_order_id: orderId });
  if (error) throw error;
  return data as Order;
}

// ---- Initial QA: piece-by-piece Repeat QA ----

/** Pass one piece on a sheet — codes it as the sheet's next repeat, photo attached. */
export async function passRepeatPiece(args: {
  orderId: string;
  sheetId: string;
  photoUrl: string;
}): Promise<Repeat> {
  const { data, error } = await supabase.rpc('qa_pass_piece', {
    p_order_id: args.orderId,
    p_sheet_id: args.sheetId,
    p_photo_url: args.photoUrl,
  });
  if (error) throw error;
  return data as Repeat;
}

/** Reject one piece, or every unresolved piece on the sheet when scope is 'sheet'. */
export async function rejectRepeatPiece(args: {
  orderId: string;
  sheetId: string;
  damageType: string;
  photoUrl: string;
  note?: string | null;
  scope: 'piece' | 'sheet';
}): Promise<{ damage_ids: string[]; count: number }> {
  const { data, error } = await supabase.rpc('qa_reject_piece', {
    p_order_id: args.orderId,
    p_sheet_id: args.sheetId,
    p_damage_type: args.damageType,
    p_photo_url: args.photoUrl,
    p_note: args.note ?? null,
    p_scope: args.scope,
  });
  if (error) throw error;
  return data as any;
}

/**
 * Re-inspect a piece the vendor sent back (0059).
 *
 * Passing codes it as a real repeat, exactly as a first-time pass would.
 * Rejecting starts the round trip again: the slot is handed to a fresh damage
 * record, which shows up on the Order Taker's Active returns once more.
 */
export async function recheckRepeatPiece(args: {
  damageId: string;
  pass: boolean;
  photoUrl: string;
  damageType?: string | null;
  note?: string | null;
}): Promise<{
  outcome: 'passed' | 'rejected';
  damage_id: string;
  repeat_id?: string;
  repeat_code?: string;
  replacement_damage_id?: string;
}> {
  const { data, error } = await supabase.rpc('qa_recheck_piece', {
    p_damage_id: args.damageId,
    p_pass: args.pass,
    p_photo_url: args.photoUrl,
    p_damage_type: args.damageType ?? null,
    p_note: args.note ?? null,
  });
  if (error) throw error;
  return data as any;
}

/** "Continue to job card" — advances the order once every piece has PASSED. */
export async function completeRepeatQa(orderId: string): Promise<Order> {
  const { data, error } = await supabase.rpc('qa_complete_repeat_qa', { p_order_id: orderId });
  if (error) throw error;
  return data as Order;
}

// ---- Floor manager ----

export async function setStageSequence(
  orderId: string,
  stages: StageInput[]
): Promise<{ stages: number }> {
  const { data, error } = await supabase.rpc('fm_set_stage_sequence', {
    p_order_id: orderId,
    p_stages: stages,
  });
  if (error) throw error;
  return data as any;
}

export async function generateJobCard(
  orderId: string
): Promise<{ job_card_id: string; lines: number }> {
  const { data, error } = await supabase.rpc('fm_generate_job_card', { p_order_id: orderId });
  if (error) throw error;
  return data as any;
}

export async function shareJobCard(orderId: string): Promise<void> {
  const { error } = await supabase.rpc('fm_share_job_card', { p_order_id: orderId });
  if (error) throw error;
}

export async function requestJobCardChanges(orderId: string, notes: string): Promise<void> {
  const { error } = await supabase.rpc('fm_request_job_card_changes', {
    p_order_id: orderId,
    p_notes: notes,
  });
  if (error) throw error;
}

export async function confirmJobCard(
  orderId: string
): Promise<{ repeats_advanced: number }> {
  const { data, error } = await supabase.rpc('fm_confirm_job_card', { p_order_id: orderId });
  if (error) throw error;
  return data as any;
}

/** Reassign a needle/colour line before the job card is confirmed. */
export async function updateJobCardLine(
  jobCardId: string,
  lineId: string,
  needleNumber: number,
  threadColorCode: string
): Promise<JobCardLine> {
  const { data, error } = await supabase.rpc('fm_update_job_card_line', {
    p_job_card_id: jobCardId,
    p_line_id: lineId,
    p_needle_number: needleNumber,
    p_thread_color_code: threadColorCode,
  });
  if (error) throw error;
  return data as JobCardLine;
}

export async function markVendorInformed(orderId: string): Promise<JobCard> {
  const { data, error } = await supabase.rpc('fm_mark_vendor_informed', { p_order_id: orderId });
  if (error) throw error;
  return data as JobCard;
}

/** Design code + stitches-per-repeat — captured before the stage sequence, so
 * this creates the draft job_cards row itself if none exists yet. */
export async function saveJobCardDesign(
  orderId: string,
  designCode: string,
  stitchesPerRepeat: number
): Promise<JobCard> {
  const { data, error } = await supabase.rpc('fm_save_job_card_design', {
    p_order_id: orderId,
    p_design_code: designCode,
    p_stitches_per_repeat: stitchesPerRepeat,
  });
  if (error) throw error;
  return data as JobCard;
}

/** Drop a needle line the auto-generation got wrong. Refuses to drop the last one. */
export async function deleteJobCardLine(jobCardId: string, lineId: string): Promise<void> {
  const { error } = await supabase.rpc('fm_delete_job_card_line', {
    p_job_card_id: jobCardId,
    p_line_id: lineId,
  });
  if (error) throw error;
}

/**
 * Append one needle line. The needle number is assigned server-side by
 * position (0053) — never passed in — so numbering can't develop a hole.
 */
export async function addJobCardLine(
  jobCardId: string,
  threadColorCode: string
): Promise<JobCardLine> {
  const { data, error } = await supabase.rpc('fm_add_job_card_line', {
    p_job_card_id: jobCardId,
    p_thread_color_code: threadColorCode,
  });
  if (error) throw error;
  return data as JobCardLine;
}

export async function askForMaterial(orderId: string): Promise<JobCard> {
  const { data, error } = await supabase.rpc('fm_ask_for_material', { p_order_id: orderId });
  if (error) throw error;
  return data as JobCard;
}

export async function startProduction(
  orderId: string
): Promise<{ order_id: string; status: string; repeats_advanced: number }> {
  const { data, error } = await supabase.rpc('fm_start_production', { p_order_id: orderId });
  if (error) throw error;
  return data as any;
}

// ---------------------------------------------------------------------------
// Repeats & Stage Tracking loop (0045, revised by 0056)
// ---------------------------------------------------------------------------

// `startStage` used to live here. Removed with the RPC in 0056 — a stage now
// opens at in_progress on its own, so there is nothing to start.

export async function sendToStageQa(repeatId: string): Promise<Repeat> {
  const { data, error } = await supabase.rpc('fm_send_to_stage_qa', { p_repeat_id: repeatId });
  if (error) throw error;
  return data as Repeat;
}

export async function passStageQa(repeatId: string): Promise<Repeat> {
  const { data, error } = await supabase.rpc('qa_pass_stage_qa', { p_repeat_id: repeatId });
  if (error) throw error;
  return data as Repeat;
}

export async function markStageDamage(
  repeatId: string,
  damageType: DamageType,
  photoUrl?: string | null,
  note?: string | null
): Promise<{ repeat_id: string; damage_id: string }> {
  const { data, error } = await supabase.rpc('mark_stage_damage', {
    p_repeat_id: repeatId,
    p_damage_type: damageType,
    p_photo_url: photoUrl ?? null,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as any;
}

// ---------------------------------------------------------------------------
// Order Taker — Returns board (0032)
//
// Read-only by construction: both RPCs are SELECT aggregates, and the order
// taker has no write path to any of the tables behind them.
// ---------------------------------------------------------------------------

export interface ReturnRepeatRow {
  repeat_id: string | null;
  repeat_code: string;
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  sheet_number: number;
  color_assignment: string;
  current_status: string;
  /** 'active' = out or awaiting QA; 'completed' = back and QA-passed. */
  bucket: 'active' | 'completed';
  stage_type: string | null;
  partner_name: string | null;
  handed_off_at: string | null;
  returned_at: string | null;
  stages_returned: number;
  sla_breached: boolean;
  ot_return_confirmed_at: string | null;
  /**
   * Which of the two things that physically go back to the vendor this is: a
   * finishing-stage return, or a piece rejected at Initial QA (0054). A
   * rejected piece never had a repeat coded for it, so `repeat_id` is null on
   * those rows — list on `entry_id`, and dispatch completion on `kind`.
   */
  kind: 'finishing' | 'qa_rejection';
  entry_id: string;
  damage_id: string | null;
  reason: string | null;
  photo_url: string | null;
  note: string | null;
  piece_index: number | null;
  piece_total: number | null;
  occurred_at: string | null;
}

export interface HandoverOrderRow {
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  status: string;
  bucket: 'ready' | 'delivered';
  total_repeats: number;
  ready_repeats: number;
  delivered_at: string | null;
  has_proof: boolean;
  has_signature: boolean;
  created_at: string;
}

export async function listReturnRepeats(): Promise<ReturnRepeatRow[]> {
  const { data, error } = await supabase.rpc('ot_return_repeats');
  if (error) throw error;
  return (data ?? []) as ReturnRepeatRow[];
}

/**
 * Order taker confirms a returned repeat has physically gone back to the vendor.
 * The photo is proof of that handback and is required by the RPC (0057) — this
 * is not a UI-only rule, so it cannot be skipped by calling the API directly.
 */
export async function completeReturn(
  repeatId: string,
  photoUrl: string,
  note?: string | null
): Promise<Repeat> {
  const { data, error } = await supabase.rpc('ot_complete_return', {
    p_repeat_id: repeatId,
    p_photo_url: photoUrl,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as Repeat;
}

/**
 * Same physical event for a piece rejected at Initial QA. A separate RPC rather
 * than an overload of the above: PostgREST resolves overloads by argument name,
 * so two functions differing only in their first parameter is the shape that
 * silently resolves to the wrong one (see 0054).
 */
export async function completeQaReturn(
  damageId: string,
  photoUrl: string,
  note?: string | null
): Promise<DamageRecord> {
  const { data, error } = await supabase.rpc('ot_complete_qa_return', {
    p_damage_id: damageId,
    p_photo_url: photoUrl,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as DamageRecord;
}

/** Dispatches on the board row's `kind`, so the screen has one action. */
export async function completeReturnEntry(row: ReturnRepeatRow, photoUrl: string): Promise<void> {
  if (row.kind === 'qa_rejection') {
    await completeQaReturn(row.damage_id ?? row.entry_id, photoUrl);
    return;
  }
  await completeReturn(row.repeat_id ?? row.entry_id, photoUrl);
}

export async function listHandoverOrders(): Promise<HandoverOrderRow[]> {
  const { data, error } = await supabase.rpc('ot_handover_orders');
  if (error) throw error;
  return (data ?? []) as HandoverOrderRow[];
}

/** Count of orders visible to the caller — for the dashboard card. */
export async function countOrders(): Promise<number> {
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}
