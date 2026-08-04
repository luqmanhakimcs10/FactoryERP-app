/**
 * Generic master-data CRUD. One implementation serves all four entities
 * (and any added later) because the table name comes from the entity config.
 *
 * factory_id is never accepted from a caller for reads — RLS scopes them. On
 * insert we must supply it (the row doesn't exist yet to be scoped), and RLS's
 * WITH CHECK verifies it matches the caller's own factory.
 */
import { supabase } from '../client';

export interface MasterRow {
  id: string;
  factory_id: string;
  name?: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  [key: string]: unknown;
}

interface ListArgs {
  table: string;
  searchField: string;
  search?: string;
  /** Include archived rows (default false). */
  includeArchived?: boolean;
  filter?: Record<string, unknown>;
}

/** Live rows for the caller's factory, newest-relevant ordering by name. */
export async function listMasters({
  table,
  searchField,
  search,
  includeArchived = false,
  filter,
}: ListArgs): Promise<MasterRow[]> {
  let q = supabase.from(table).select('*');

  if (!includeArchived) q = q.is('deleted_at', null);
  if (search?.trim()) q = q.ilike(searchField, `%${search.trim()}%`);
  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (value === null || value === '') continue;
      q = q.eq(key, value as string);
    }
  }

  const { data, error } = await q.order(searchField, { ascending: true });
  if (error) throw error;
  return (data ?? []) as MasterRow[];
}

export async function countMasters(table: string): Promise<number> {
  const { count, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function getMaster(table: string, id: string): Promise<MasterRow | null> {
  const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as MasterRow) ?? null;
}

export async function createMaster(
  table: string,
  factoryId: string,
  values: Record<string, unknown>
): Promise<MasterRow> {
  const { data, error } = await supabase
    .from(table)
    .insert({ ...values, factory_id: factoryId })
    .select()
    .single();
  if (error) throw error;
  return data as MasterRow;
}

export async function updateMaster(
  table: string,
  id: string,
  values: Record<string, unknown>
): Promise<MasterRow> {
  const { data, error } = await supabase
    .from(table)
    .update(values)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as MasterRow;
}

export interface VendorDetailStats {
  totalOrders: number;
  processingOrders: number;
  remainingOrders: number;
  invoiced: number;
  collected: number;
  remaining: number;
}

export interface SupplierDetailStats {
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

export interface PurchaseOrderDetail {
  id: string;
  po_code: string;
  status: string;
  amount: number | null;
  created_at: string;
}

export interface PartnerDetailStats {
  repeatsInHand: number;
  totalRepeats: number;
  completedRepeats: number;
  damageCount: number;
  damageQuantity: number;
  damageDeduction: number;
  income: number;
  revenueMonth: number;
  revenueTotal: number;
}

function safeSum(rows: Array<{ amount: number | null }>): number {
  return rows.reduce((sum, row) => sum + (row.amount ?? 0), 0);
}

export async function getVendorStats(vendorId: string): Promise<VendorDetailStats> {
  const { count: totalOrdersCount, error: totalOrdersError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', vendorId);
  if (totalOrdersError) throw totalOrdersError;

  const { count: processingCount, error: processingError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', vendorId)
    .in('status', ['in_production', 'in_finishing', 'awaiting_final_qa', 'ready_for_delivery']);
  if (processingError) throw processingError;

  const { count: remainingCount, error: remainingError } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', vendorId)
    .not('status', 'in', ['completed', 'cancelled']);
  if (remainingError) throw remainingError;

  const { data: invoiceRows, error: invoiceError } = await supabase
    .from('invoices')
    .select('id, amount')
    .eq('vendor_id', vendorId)
    .neq('status', 'cancelled');
  if (invoiceError) throw invoiceError;

  const invoiceIds = (invoiceRows ?? []).map((row) => (row as any).id).filter(Boolean);
  let collected = 0;
  if (invoiceIds.length > 0) {
    const { data: paymentRows, error: paymentError } = await supabase
      .from('payments')
      .select('amount')
      .eq('direction', 'receivable')
      .eq('ref_type', 'invoice')
      .in('ref_id', invoiceIds);
    if (paymentError) throw paymentError;
    collected = safeSum(paymentRows ?? []);
  }

  const invoiced = safeSum(invoiceRows ?? []);

  return {
    totalOrders: totalOrdersCount ?? 0,
    processingOrders: processingCount ?? 0,
    remainingOrders: remainingCount ?? 0,
    invoiced,
    collected,
    remaining: Math.max(invoiced - collected, 0),
  };
}

export async function getSupplierStats(supplierId: string): Promise<SupplierDetailStats> {
  const { data: poRows, error: poError } = await supabase
    .from('purchase_orders')
    .select('id, amount')
    .eq('supplier_id', supplierId)
    .neq('status', 'cancelled');
  if (poError) throw poError;

  const totalAmount = safeSum(poRows ?? []);
  const poIds = (poRows ?? []).map((row) => (row as any).id).filter(Boolean);
  let paidAmount = 0;

  if (poIds.length > 0) {
    const { data: paymentRows, error: paymentError } = await supabase
      .from('payments')
      .select('amount')
      .eq('direction', 'payable')
      .eq('ref_type', 'po')
      .in('ref_id', poIds);
    if (paymentError) throw paymentError;
    paidAmount = safeSum(paymentRows ?? []);
  }

  return {
    totalAmount,
    paidAmount,
    remainingAmount: Math.max(totalAmount - paidAmount, 0),
  };
}

export async function getSupplierPurchaseOrders(
  supplierId: string
): Promise<PurchaseOrderDetail[]> {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, po_code, status, amount, created_at')
    .eq('supplier_id', supplierId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PurchaseOrderDetail[];
}

export async function getPartnerStats(partnerId: string): Promise<PartnerDetailStats> {
  const { count: repeatsInHand, error: handError } = await supabase
    .from('repeat_stage_history')
    .select('id', { count: 'exact', head: true })
    .eq('partner_id', partnerId)
    .not('handed_off_at', 'is', null)
    .is('returned_at', null);
  if (handError) throw handError;

  const { count: totalRepeats, error: allError } = await supabase
    .from('repeat_stage_history')
    .select('repeat_id', { count: 'exact', head: true })
    .eq('partner_id', partnerId)
    .not('handed_off_at', 'is', null);
  if (allError) throw allError;

  const { count: completedRepeats, error: completedError } = await supabase
    .from('repeat_stage_history')
    .select('repeat_id', { count: 'exact', head: true })
    .eq('partner_id', partnerId)
    .not('returned_at', 'is', null);
  if (completedError) throw completedError;

  // Scoped to THIS partner. Without responsible_id every partner's detail showed
  // the factory's entire partner-damage total, so two partners with one damage
  // between them both showed "1". `quantity_meters` lands with 0031.
  const { data: damageRows, error: damageError } = await supabase
    .from('damage_records')
    .select('deduction, quantity_meters')
    .eq('responsible_type', 'partner')
    .eq('responsible_id', partnerId)
    .neq('approval_status', 'rejected');
  if (damageError) throw damageError;

  const damageCount = (damageRows ?? []).length;
  const damageDeduction = (damageRows ?? []).reduce(
    (sum, row) => sum + Number((row as any).deduction ?? 0),
    0
  );
  const damageQuantity = (damageRows ?? []).reduce(
    (sum, row) => sum + Number((row as any).quantity_meters ?? 0),
    0
  );

  const { data: incomeRows, error: incomeError } = await supabase
    .from('partner_ledger')
    .select('amount')
    .eq('partner_id', partnerId)
    .eq('entry_type', 'earning');
  if (incomeError) throw incomeError;

  const income = safeSum(incomeRows ?? []);

  const { data: stageRows, error: stageError } = await supabase
    .from('order_stages')
    .select('order_id')
    .eq('partner_id', partnerId);
  if (stageError) throw stageError;

  const orderIds = Array.from(new Set((stageRows ?? []).map((r: any) => r.order_id).filter(Boolean)));
  let revenueTotal = 0;
  let revenueMonth = 0;

  if (orderIds.length > 0) {
    const { data: invoiceRows, error: invoiceError } = await supabase
      .from('invoices')
      .select('amount, issued_at')
      .in('order_id', orderIds)
      .neq('status', 'cancelled');
    if (invoiceError) throw invoiceError;

    const invoices = invoiceRows ?? [];
    revenueTotal = safeSum(invoices as Array<{ amount: number | null }>);
    const now = new Date();
    revenueMonth = safeSum(
      (invoices as Array<{ amount: number | null; issued_at: string }>).filter((inv) => {
        if (!inv.issued_at) return false;
        const issued = new Date(inv.issued_at);
        return issued.getUTCFullYear() === now.getUTCFullYear() && issued.getUTCMonth() === now.getUTCMonth();
      })
    );
  }

  return {
    repeatsInHand: repeatsInHand ?? 0,
    totalRepeats: totalRepeats ?? 0,
    completedRepeats: completedRepeats ?? 0,
    damageCount,
    damageQuantity,
    damageDeduction,
    income,
    revenueMonth,
    revenueTotal,
  };
}

/**
 * Archive (soft delete). Masters are reference data that later phases link to,
 * so rows are retired, never destroyed — no orphaned foreign keys, and history
 * still resolves the record's name.
 */
export async function archiveMaster(table: string, id: string): Promise<void> {
  const { error } = await supabase
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function restoreMaster(table: string, id: string): Promise<void> {
  const { error } = await supabase.from(table).update({ deleted_at: null }).eq('id', id);
  if (error) throw error;
}

/** Options for a `linked` field — RLS keeps this to the caller's own factory. */
export async function listLinkedOptions(
  table: string,
  labelColumn: string,
  filter?: Record<string, string>
): Promise<{ value: string; label: string }[]> {
  let q = supabase.from(table).select(`id, ${labelColumn}`);
  for (const [col, val] of Object.entries(filter ?? {})) q = q.eq(col, val);

  const { data, error } = await q.order(labelColumn, { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    value: r.id as string,
    label: (r[labelColumn] as string) || '(unnamed)',
  }));
}
