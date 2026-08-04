/**
 * Accountant dashboard API — the six boxes and the invoices hub (0031).
 *
 * Every call here is a read. Nothing in this file owns a table: each RPC
 * aggregates the transaction tables live (invoices, payments, purchase_orders,
 * worker_ledger, leaves, shifts, partner_ledger, damage_records, expenses), so
 * a figure that looks wrong is fixed in the transaction that wrote it, never in
 * a stored total that can drift.
 *
 * Writes still go through `finance.ts` — recording money is the same posting
 * path for the accountant's new screens as for the Phase 7 ones, including the
 * photo requirement.
 */
import { supabase } from '../client';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw error;
  return (data ?? []) as T[];
}

// ---------------------------------------------------------------------------
// Box 1 — Clients
// ---------------------------------------------------------------------------

export interface ClientSummary {
  vendor_id: string;
  name: string;
  contact: string | null;
  address: string | null;
  rate_per_repeat: number | null;
  rate_per_stitch: number | null;
  price: number | null;
  invoice_count: number;
  unpaid_count: number;
  total_income: number;
  received: number;
  pending: number;
  next_due_date: string | null;
  damage_count: number;
  damage_deduction: number;
}

export interface ClientInvoice {
  invoice_id: string;
  invoice_code: string;
  order_code: string | null;
  amount: number;
  status: 'pending' | 'paid' | 'cancelled';
  photo_url: string | null;
  due_date: string | null;
  issued_at: string;
  paid_at: string | null;
  paid_amount: number;
  is_overdue: boolean;
}

export interface ClientDamage {
  damage_id: string;
  order_code: string | null;
  stage_type: string;
  damage_type: string;
  deduction: number;
  quantity_meters: number;
  approval_status: string;
  photo_url: string | null;
  note: string | null;
  created_at: string;
}

export const listClientSummaries = () => rpc<ClientSummary>('acct_client_summary');

export const listClientInvoices = (vendorId: string) =>
  rpc<ClientInvoice>('acct_client_invoices', { p_vendor_id: vendorId });

export const listClientDamages = (vendorId: string) =>
  rpc<ClientDamage>('acct_client_damages', { p_vendor_id: vendorId });

// ---------------------------------------------------------------------------
// Box 2 — Suppliers
// ---------------------------------------------------------------------------

export interface SupplierSummary {
  supplier_id: string;
  name: string;
  contact: string | null;
  address: string | null;
  payment_day: number | null;
  po_count: number;
  unpaid_po_count: number;
  po_value: number;
  paid: number;
  outstanding: number;
  next_billing_date: string | null;
}

export interface SupplierPo {
  po_id: string;
  po_code: string;
  status: string;
  amount: number | null;
  quantity_meters: number;
  item_count: number;
  created_at: string;
  paid_at: string | null;
}

export const listSupplierSummaries = () => rpc<SupplierSummary>('acct_supplier_summary');

export const listSupplierPos = (supplierId: string) =>
  rpc<SupplierPo>('acct_supplier_pos', { p_supplier_id: supplierId });

// ---------------------------------------------------------------------------
// Box 4 — Employees (every role)
// ---------------------------------------------------------------------------

export interface EmployeeSummary {
  user_id: string;
  display_name: string;
  contact: string | null;
  role: string;
  is_active: boolean;
  salary_type: 'per_month' | 'per_day' | 'per_stitch';
  salary_amount: number;
  period: string;
  days_worked: number;
  stitches: number;
  bonus: number;
  fine: number;
  loan_deducted: number;
  leave_requests: number;
  leave_days: number;
  total_salary: number;
  next_pay_date: string;
}

export const listEmployeeSummaries = (period?: string) =>
  rpc<EmployeeSummary>('acct_employee_summary', { p_period: period ?? null });

// ---------------------------------------------------------------------------
// Box 5 — Machines
// ---------------------------------------------------------------------------

export interface MachineSummary {
  machine_id: string;
  name: string;
  machine_type: string;
  shift_count: number;
  closed_shifts: number;
  open_shifts: number;
  idle_shifts: number;
  total_minutes: number;
  total_hours: number;
  last_shift_at: string | null;
}

export interface MachineShift {
  shift_id: string;
  worker_name: string | null;
  status: string;
  opened_at: string;
  closed_at: string | null;
  minutes: number | null;
  stitches: number;
}

export const listMachineSummaries = () => rpc<MachineSummary>('acct_machine_summary');

export const listMachineShifts = (machineId: string) =>
  rpc<MachineShift>('acct_machine_shifts', { p_machine_id: machineId });

// ---------------------------------------------------------------------------
// Box 6 — Invoices: receivable
// ---------------------------------------------------------------------------

export interface ReceivableSummary {
  invoice_count: number;
  unpaid_count: number;
  overdue_count: number;
  total_income: number;
  received: number;
  pending: number;
  overdue_amount: number;
  next_due_date: string | null;
}

export interface ReceivableInvoice {
  invoice_id: string;
  invoice_code: string;
  vendor_id: string;
  vendor_name: string;
  order_code: string | null;
  amount: number;
  status: 'pending' | 'paid' | 'cancelled';
  photo_url: string | null;
  due_date: string | null;
  issued_at: string;
  is_overdue: boolean;
}

export async function getReceivableSummary(): Promise<ReceivableSummary | null> {
  const rows = await rpc<ReceivableSummary>('acct_receivable_summary');
  return rows[0] ?? null;
}

export const listReceivableInvoices = () => rpc<ReceivableInvoice>('acct_receivable_invoices');

// ---------------------------------------------------------------------------
// Box 6 — Invoices: the five payable categories
// ---------------------------------------------------------------------------

export interface PayablePartner {
  partner_id: string;
  name: string;
  stage_type: string;
  earnings: number;
  damages: number;
  paid: number;
  payable: number;
}

export interface PayableSupplierPo {
  po_id: string;
  po_code: string;
  supplier_id: string | null;
  supplier_name: string | null;
  status: string;
  amount: number | null;
  quantity_meters: number;
  created_at: string;
}

export interface PayableExpense {
  expense_id: string;
  category: string;
  bill_subtype: string | null;
  amount: number;
  description: string | null;
  proof_url: string | null;
  recurring: boolean;
  status: 'pending' | 'approved' | 'rejected';
  expense_date: string;
}

export interface BillSubtype {
  bill_subtype: string;
  use_count: number;
  total_amount: number;
  last_used: string;
}

export interface SalaryOutstanding {
  period: string;
  employee_count: number;
  pending_count: number;
  pending_net: number;
  finalized_net: number;
  unpaid_finalized: number;
  next_pay_date: string;
}

export const listPayablePartners = () => rpc<PayablePartner>('acct_payable_partners');

export const listPayableSupplierPos = () => rpc<PayableSupplierPo>('acct_payable_suppliers');

export const listPayableExpenses = (category: 'bills' | 'maintenance') =>
  rpc<PayableExpense>('acct_payable_expenses', { p_category: category });

/** Prior bill type names — typing a new one here is how a bill type gets added. */
export const listBillSubtypes = () => rpc<BillSubtype>('acct_bill_subtypes');

export async function getSalaryOutstanding(period?: string): Promise<SalaryOutstanding | null> {
  const rows = await rpc<SalaryOutstanding>('acct_salary_outstanding', {
    p_period: period ?? null,
  });
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Dashboard card counts
// ---------------------------------------------------------------------------

/**
 * Live invoice count for the dashboard card. RLS (not this query) is what keeps
 * it to the caller's factory, and returns 0 rather than an error when the
 * finance module is off.
 */
export async function countInvoices(): Promise<number> {
  const { count, error } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .neq('status', 'cancelled');
  if (error) throw error;
  return count ?? 0;
}
