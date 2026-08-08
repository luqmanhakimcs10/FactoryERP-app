/**
 * Inventory & procurement API.
 *
 * Every stock-changing operation goes through an RPC — never a direct write to
 * `thread_stock`. That is what guarantees a `stock_movements` row is written in
 * the same transaction as the balance change. Phase 7's leakage report reads only
 * that ledger, and a movement missed now cannot be backfilled later.
 */
import { supabase } from '../client';
import type {
  ThreadStock,
  PurchaseOrder,
  Grn,
  MaterialIssueQueueRow,
  JobCardRequirement,
  StockLedgerRow,
  StockAudit,
  MaterialIssue,
  PendingMaterialIssueRow,
} from '../../models/inventoryTypes';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listThreadStock(search?: string): Promise<ThreadStock[]> {
  let q = supabase.from('thread_stock').select('*').order('color_code');
  if (search?.trim()) q = q.ilike('color_code', `%${search.trim()}%`);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ThreadStock[];
}

/**
 * Set (or clear, by passing null) a colour's automatic reorder point.
 *
 * Returns a one-row array, not an object: 0074 changed the function to a
 * `returns table (...)` so it would stop depending on the composite type of the
 * `thread_stock` view — that dependency made re-running 0068's `drop view`
 * impossible. The columns are unchanged.
 */
export async function setReorderLevels(
  colorCode: string,
  reorderThreshold: number | null,
  reorderQuantity: number | null
): Promise<ThreadStock | null> {
  const { data, error } = await supabase.rpc('sm_set_reorder_levels', {
    p_color_code: colorCode,
    p_reorder_threshold: reorderThreshold,
    p_reorder_quantity: reorderQuantity,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

export async function listPurchaseOrders(statuses?: string[]): Promise<PurchaseOrder[]> {
  let q = supabase
    .from('purchase_orders')
    .select('*, suppliers(name), orders(order_code), po_items(*)')
    .order('created_at', { ascending: false });
  if (statuses?.length) q = q.in('status', statuses);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any;
}

export async function getPurchaseOrder(poId: string): Promise<PurchaseOrder | null> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, suppliers(name, contact), orders(order_code), po_items(*)')
    .eq('id', poId)
    .maybeSingle();
  if (error) throw error;
  return (data as any) ?? null;
}

export async function listGrns(statuses?: string[]): Promise<Grn[]> {
  let q = supabase
    .from('grns')
    .select('*, purchase_orders(po_code, suppliers(name)), grn_items(*)')
    .order('handed_over_at', { ascending: false });
  if (statuses?.length) q = q.in('status', statuses);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any;
}

export async function getGrn(grnId: string): Promise<Grn | null> {
  const { data, error } = await supabase
    .from('grns')
    .select('*, purchase_orders(po_code, suppliers(name)), grn_items(*)')
    .eq('id', grnId)
    .maybeSingle();
  if (error) throw error;
  return (data as any) ?? null;
}

/** Confirmed job cards with no material issue yet. */
export async function getMaterialIssueQueue(): Promise<MaterialIssueQueueRow[]> {
  const { data, error } = await supabase.rpc('material_issue_queue');
  if (error) throw error;
  return (data ?? []) as MaterialIssueQueueRow[];
}

/** Requirement per colour for a job card, with current availability. */
export async function getJobCardRequirements(jobCardId: string): Promise<JobCardRequirement[]> {
  const { data, error } = await supabase.rpc('job_card_requirements', {
    p_job_card_id: jobCardId,
  });
  if (error) throw error;
  return (data ?? []) as JobCardRequirement[];
}

/** Full movement history for one colour, oldest first, with running balance. */
export async function getStockLedger(colorCode: string): Promise<StockLedgerRow[]> {
  const { data, error } = await supabase.rpc('stock_ledger', { p_color_code: colorCode });
  if (error) throw error;
  return (data ?? []) as StockLedgerRow[];
}

export async function listStockAudits(): Promise<StockAudit[]> {
  const { data, error } = await supabase
    .from('stock_audits')
    .select('*, stock_audit_items(*)')
    .order('submitted_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

export async function listMaterialIssues(): Promise<MaterialIssue[]> {
  const { data, error } = await supabase
    .from('material_issues')
    .select('*, orders(order_code), material_issue_items(*)')
    .order('issued_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

/** Whether this factory has already done its one-time opening entry. */
export async function getOpeningStockState(
  factoryId: string
): Promise<{ completed: boolean; completedAt: string | null }> {
  const { data, error } = await supabase
    .from('factories')
    .select('opening_stock_completed_at')
    .eq('id', factoryId)
    .maybeSingle();
  if (error) throw error;
  return {
    completed: !!data?.opening_stock_completed_at,
    completedAt: data?.opening_stock_completed_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Procurement transitions
// ---------------------------------------------------------------------------

export async function createManualPo(args: {
  supplierId: string | null;
  items: { color_code?: string | null; description?: string | null; quantity_meters: number }[];
  notes?: string | null;
}): Promise<PurchaseOrder> {
  const { data, error } = await supabase.rpc('po_create_manual', {
    p_supplier_id: args.supplierId,
    p_items: args.items,
    p_notes: args.notes ?? null,
  });
  if (error) throw error;
  return data as PurchaseOrder;
}

export async function executePo(poId: string): Promise<PurchaseOrder> {
  const { data, error } = await supabase.rpc('po_execute', { p_po_id: poId });
  if (error) throw error;
  return data as PurchaseOrder;
}

export async function uploadPoBill(
  poId: string,
  billUrl: string,
  amount?: number | null
): Promise<PurchaseOrder> {
  const { data, error } = await supabase.rpc('po_upload_bill', {
    p_po_id: poId,
    p_bill_url: billUrl,
    p_amount: amount ?? null,
  });
  if (error) throw error;
  return data as PurchaseOrder;
}

export async function handoverPoToStore(poId: string, note?: string | null): Promise<Grn> {
  const { data, error } = await supabase.rpc('po_handover_to_store', {
    p_po_id: poId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as Grn;
}

// ---------------------------------------------------------------------------
// Store manager transitions
// ---------------------------------------------------------------------------

export async function confirmGrn(
  grnId: string,
  received?: { grn_item_id: string; received_meters: number }[]
): Promise<{ lines_received: number }> {
  const { data, error } = await supabase.rpc('sm_confirm_grn', {
    p_grn_id: grnId,
    p_received: received ?? null,
  });
  if (error) throw error;
  return data as any;
}

export async function issueMaterials(
  jobCardId: string,
  note?: string | null
): Promise<{ issue_code: string; lines: number; total_meters: number }> {
  const { data, error } = await supabase.rpc('sm_issue_materials', {
    p_job_card_id: jobCardId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as any;
}

export async function submitStockAudit(
  items: { color_code: string; actual_meters: number }[],
  note?: string | null
): Promise<{ audit_code: string; colors_counted: number; variances: number }> {
  const { data, error } = await supabase.rpc('sm_submit_audit', {
    p_items: items,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as any;
}

// ---------------------------------------------------------------------------
// Floor manager: accept inventory
// ---------------------------------------------------------------------------

/** Material issues waiting on the floor manager to confirm pickup. */
export async function listPendingMaterialAcceptance(): Promise<PendingMaterialIssueRow[]> {
  const { data, error } = await supabase.rpc('fm_material_issue_queue');
  if (error) throw error;
  return (data ?? []) as PendingMaterialIssueRow[];
}

export async function acceptInventory(materialIssueId: string, photoUrl: string): Promise<MaterialIssue> {
  const { data, error } = await supabase.rpc('fm_accept_inventory', {
    p_material_issue_id: materialIssueId,
    p_photo_url: photoUrl,
  });
  if (error) throw error;
  return data as MaterialIssue;
}

/** One-time per factory; the DB refuses a second run. */
export async function submitOpeningStock(
  items: { color_code: string; quantity_meters: number }[]
): Promise<{ colors: number }> {
  const { data, error } = await supabase.rpc('sm_opening_stock', { p_items: items });
  if (error) throw error;
  return data as any;
}
