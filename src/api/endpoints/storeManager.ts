/**
 * Store Manager restructure: PO, Inventory, Audit, Requests — plus the Floor
 * Manager's handover back to the store.
 *
 * Kept apart from `inventory.ts` because that file is the Phase 4 thread-only
 * surface and is still used by the GRN and opening-stock screens. Mixing the
 * four-type API into it would leave no clear answer to which of two similar
 * functions a new screen should call.
 *
 * Every write here goes through an RPC. Nothing in this file writes
 * `inventory_items` directly — that is what keeps a `stock_movements` row in the
 * same transaction as the balance change it explains.
 */
import { supabase } from '../client';
// Same row shape as the colour-keyed ledger — 0081 returns stock_ledger's exact
// column list so both can feed one screen.
import type { StockLedgerRow } from '../../models/inventoryTypes';

export type ItemType = 'thread' | 'tilla' | 'sequin' | 'bobbin';

export const ITEM_TYPES: ItemType[] = ['thread', 'tilla', 'sequin', 'bobbin'];

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  thread: 'Thread',
  tilla: 'Tilla',
  sequin: 'Sequin',
  bobbin: 'Bobbin',
};

export interface InventoryItem {
  id: string;
  item_type: ItemType;
  color_code: string;
  color_name: string | null;
  quantity: number;
  unit: string;
  source: 'po' | 'manual';
  size_mm: number | null;
  sequin_type: string | null;
  cd_count: number | null;
  yards_per_cd: number | null;
  reorder_threshold: number | null;
  updated_at: string;
}

export interface SmPoRow {
  id: string;
  po_code: string;
  status: string;
  origin: 'auto_shortfall' | 'manual';
  supplier_name: string | null;
  order_code: string | null;
  assigned_to: string | null;
  line_count: number;
  total_quantity: number;
  created_at: string;
}

export interface MaterialRequestRow {
  id: string;
  request_code: string;
  order_id: string;
  order_code: string;
  vendor_name: string | null;
  job_card_id: string | null;
  origin: 'job_card' | 'auto_stock_ready';
  directed_to: 'store_manager' | 'floor_manager';
  status: 'pending' | 'issued' | 'completed' | 'cancelled';
  requested_at: string;
  completed_at: string | null;
}

export interface AuditWalkItem {
  inventory_item_id: string;
  item_type: ItemType;
  color_code: string;
  color_name: string | null;
  expected_quantity: number;
  unit: string;
  size_mm: number | null;
  sequin_type: string | null;
}

export interface AuditHistoryRow {
  id: string;
  audit_code: string;
  audit_date: string;
  audit_type: 'daily' | 'weekly';
  conducted_by: string | null;
  item_count: number;
  corrected: number;
  submitted_at: string;
}

export interface AuditDetailRow {
  color_code: string;
  color_name: string | null;
  item_type: ItemType;
  unit: string;
  expected_quantity: number;
  actual_quantity: number;
  variance: number;
  marked_correct: boolean | null;
}

export interface HandoverLine {
  inventory_item_id: string;
  item_type: ItemType;
  color_code: string;
  color_name: string | null;
  unit: string;
  issued_quantity: number;
  on_machine: boolean;
}

export interface MountedItem {
  id: string;
  item_type: ItemType;
  color_code: string;
  color_name: string | null;
  quantity: number;
  unit: string;
  order_code: string | null;
  mounted_at: string;
}

/**
 * Sequins in a number of CD rolls: (yards_per_CD x 914 / size_mm) x 0.8.
 *
 * This mirrors `sequin_count_from_cds` in the database and exists ONLY to show
 * the number live as the user types. The value that gets stored is always the
 * one the database computes from the CD count — this copy is never sent.
 */
export function previewSequinCount(
  cdCount: number,
  sizeMm: number,
  yardsPerCd = 90
): number | null {
  if (!cdCount || !sizeMm || sizeMm <= 0) return null;
  return Math.round(cdCount * ((yardsPerCd * 914) / sizeMm) * 0.8);
}

// ---------------------------------------------------------------------------
// Tab 2 — Inventory
// ---------------------------------------------------------------------------

export async function listInventory(itemType?: ItemType | null): Promise<InventoryItem[]> {
  const { data, error } = await supabase.rpc('inventory_list', {
    p_item_type: itemType ?? null,
  });
  if (error) throw error;
  return (data ?? []) as InventoryItem[];
}

export async function addInventory(args: {
  itemType: ItemType;
  colorCode: string;
  quantity?: number | null;
  colorName?: string | null;
  sizeMm?: number | null;
  sequinType?: string | null;
  cdCount?: number | null;
  yardsPerCd?: number | null;
  note?: string | null;
}): Promise<InventoryItem> {
  const { data, error } = await supabase.rpc('sm_add_inventory', {
    p_item_type: args.itemType,
    p_color_code: args.colorCode,
    p_quantity: args.quantity ?? null,
    p_color_name: args.colorName ?? null,
    p_size_mm: args.sizeMm ?? null,
    p_sequin_type: args.sequinType ?? null,
    p_cd_count: args.cdCount ?? null,
    p_yards_per_cd: args.yardsPerCd ?? 90,
    p_note: args.note ?? null,
  });
  if (error) throw error;
  return data as InventoryItem;
}

/**
 * Movement history for ONE item.
 *
 * Use this, not `getStockLedger(colorCode)`, for anything that is not known to be
 * thread: since 0068 a colour code can belong to a thread AND a tilla AND a
 * sequin, and the colour-keyed version merges all of them into one nonsensical
 * running balance (see 0081).
 */
export async function getInventoryLedger(itemId: string): Promise<StockLedgerRow[]> {
  const { data, error } = await supabase.rpc('inventory_ledger', { p_item_id: itemId });
  if (error) throw error;
  return (data ?? []) as StockLedgerRow[];
}

export async function listMountedItems(machineId: string): Promise<MountedItem[]> {
  const { data, error } = await supabase.rpc('machine_mounted_list', {
    p_machine_id: machineId,
  });
  if (error) throw error;
  return (data ?? []) as MountedItem[];
}

// ---------------------------------------------------------------------------
// Tab 1 — PO
// ---------------------------------------------------------------------------

export async function listStorePos(): Promise<SmPoRow[]> {
  const { data, error } = await supabase.rpc('sm_po_list');
  if (error) throw error;
  return (data ?? []) as SmPoRow[];
}

export async function listProcurementUsers(): Promise<{ id: string; display_name: string }[]> {
  const { data, error } = await supabase.rpc('procurement_users');
  if (error) throw error;
  return (data ?? []) as { id: string; display_name: string }[];
}

export async function createStorePo(args: {
  items: { inventory_item_id?: string; description?: string; quantity: number }[];
  assignedTo: string;
  supplierId?: string | null;
  note?: string | null;
}): Promise<{ id: string; po_code: string }> {
  const { data, error } = await supabase.rpc('sm_create_manual_po', {
    p_items: args.items,
    p_assigned_to: args.assignedTo,
    p_supplier_id: args.supplierId ?? null,
    p_note: args.note ?? null,
  });
  if (error) throw error;
  return data as { id: string; po_code: string };
}

// ---------------------------------------------------------------------------
// Tab 3 — Audit
// ---------------------------------------------------------------------------

export async function getAuditTodayState(): Promise<{
  done: boolean;
  audit_id: string | null;
  audit_code: string | null;
  submitted_at: string | null;
  item_count: number | null;
}> {
  const { data, error } = await supabase.rpc('audit_today_state');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (
    row ?? { done: false, audit_id: null, audit_code: null, submitted_at: null, item_count: null }
  );
}

export async function getAuditWalkItems(): Promise<AuditWalkItem[]> {
  const { data, error } = await supabase.rpc('audit_walk_items');
  if (error) throw error;
  return (data ?? []) as AuditWalkItem[];
}

export async function submitDailyAudit(
  items: { inventory_item_id: string; correct: boolean; actual_quantity?: number }[],
  note?: string | null
): Promise<{ audit_code: string; items: number; corrected: number }> {
  const { data, error } = await supabase.rpc('sm_submit_daily_audit', {
    p_items: items,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as any;
}

export async function getAuditHistory(limit = 60): Promise<AuditHistoryRow[]> {
  const { data, error } = await supabase.rpc('audit_history', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as AuditHistoryRow[];
}

export async function getAuditDetail(auditId: string): Promise<AuditDetailRow[]> {
  const { data, error } = await supabase.rpc('audit_detail', { p_audit_id: auditId });
  if (error) throw error;
  return (data ?? []) as AuditDetailRow[];
}

// ---------------------------------------------------------------------------
// Tab 4 — Requests
// ---------------------------------------------------------------------------

export async function getMaterialRequestHistory(): Promise<MaterialRequestRow[]> {
  const { data, error } = await supabase.rpc('material_request_history');
  if (error) throw error;
  return (data ?? []) as MaterialRequestRow[];
}

export async function acknowledgeMaterialRequest(requestId: string): Promise<MaterialRequestRow> {
  const { data, error } = await supabase.rpc('fm_acknowledge_material_request', {
    p_request_id: requestId,
  });
  if (error) throw error;
  return data as MaterialRequestRow;
}

// ---------------------------------------------------------------------------
// Floor Manager — handover to the store
// ---------------------------------------------------------------------------

export interface HandoverQueueRow {
  order_id: string;
  order_code: string;
  vendor_name: string | null;
  status: string;
  line_count: number;
  finished_at: string;
}

export async function getHandoverQueue(): Promise<HandoverQueueRow[]> {
  const { data, error } = await supabase.rpc('fm_handover_queue');
  if (error) throw error;
  return (data ?? []) as HandoverQueueRow[];
}

export async function getHandoverLines(orderId: string): Promise<HandoverLine[]> {
  const { data, error } = await supabase.rpc('fm_handover_lines', { p_order_id: orderId });
  if (error) throw error;
  return (data ?? []) as HandoverLine[];
}

export async function submitHandover(
  orderId: string,
  items: {
    inventory_item_id: string;
    issued_quantity: number;
    leftover_quantity: number;
    on_machine: boolean;
  }[],
  note?: string | null
): Promise<{ handover_code: string; lines: number; returned_quantity: number }> {
  const { data, error } = await supabase.rpc('fm_submit_handover', {
    p_order_id: orderId,
    p_items: items,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as any;
}

export async function getHandoverDetail(orderId: string): Promise<
  {
    handover_code: string;
    handed_over_at: string;
    handed_over_by: string | null;
    color_code: string;
    unit: string;
    issued_quantity: number;
    leftover_quantity: number;
    on_machine: boolean;
  }[]
> {
  const { data, error } = await supabase.rpc('fm_handover_detail', { p_order_id: orderId });
  if (error) throw error;
  return (data ?? []) as any;
}
