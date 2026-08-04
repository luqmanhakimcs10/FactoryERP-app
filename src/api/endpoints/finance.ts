/**
 * Phase 7 finance API — invoices, payments, expenses, loans, approvals, reports.
 *
 * Every posting goes through an RPC. The partner payment in particular MUST stay
 * a single call: it writes payments + expenses + partner_ledger together, and
 * splitting it into three client calls would let two succeed and one fail,
 * leaving the P&L, the payables view and the partner's dashboard disagreeing.
 */
import { supabase } from '../client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Invoice {
  id: string;
  factory_id: string;
  order_id: string;
  invoice_code: string;
  amount: number;
  status: 'pending' | 'paid' | 'cancelled';
  issued_at: string;
  paid_at: string | null;
  note: string | null;
  /** Required from 0031 onwards — the DB refuses an invoice without one. */
  photo_url: string | null;
  due_date: string | null;
  orders?: { order_code: string | null; vendors?: { name: string } | null } | null;
}

export interface Payment {
  id: string;
  direction: 'receivable' | 'payable';
  ref_type: 'invoice' | 'po' | 'partner' | 'salary';
  ref_id: string | null;
  amount: number;
  proof_url: string | null;
  paid_at: string;
  note: string | null;
}

export interface Expense {
  id: string;
  category: string;
  /** Free text, only for category = 'bills' — "electricity" and friends (0031). */
  bill_subtype: string | null;
  amount: number;
  description: string | null;
  proof_url: string | null;
  recurring: boolean;
  expense_date: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

export interface Loan {
  id: string;
  worker_id: string;
  principal: number;
  balance: number;
  installment_amount: number;
  status: 'active' | 'paid_off';
  starts_period: string | null;
  created_at: string;
  profiles?: { display_name: string } | null;
}

export interface ApprovalRow {
  kind: 'expense' | 'damage' | 'bonus_slab';
  id: string;
  title: string;
  subtitle: string;
  amount: number | null;
  created_at: string;
}

export interface FinalQaRow {
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  total_repeats: number;
  ready_repeats: number;
}

export interface CompanyPl {
  revenue_invoiced: number;
  revenue_collected: number;
  thread_cost: number;
  labor_cost: number;
  finishing_cost: number;
  other_expenses: number;
  total_cost: number;
  net_profit: number;
}

export interface OrderProfit {
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  status: string;
  invoice_code: string | null;
  revenue: number;
  thread_cost: number;
  labor_cost: number;
  finishing_cost: number;
  fixed_allocated: number;
  total_cost: number;
  profit: number;
  margin_pct: number | null;
}

export interface LeakageRow {
  color_code: string;
  opening_meters: number;
  received_meters: number;
  issued_meters: number;
  audit_variance: number;
  current_balance: number;
  expected_balance: number;
  leakage_pct: number | null;
  movement_count: number;
}

export interface ProductivityRow {
  worker_id: string;
  worker_name: string;
  periods: number;
  shifts_worked: number;
  total_stitches: number;
  avg_stitches: number;
  gross_pay: number;
  bonus: number;
  damage_deduction: number;
  loan_installment: number;
  net_pay: number;
  damage_count: number;
}

export interface UptimeRow {
  machine_id: string;
  machine_name: string;
  shifts_total: number;
  shifts_closed: number;
  shifts_idle: number;
  run_minutes: number;
  downtime_minutes: number;
  uptime_pct: number | null;
  total_stitches: number;
  downtime_events: number;
}

// ---------------------------------------------------------------------------
// Final QA + invoicing
// ---------------------------------------------------------------------------

export async function getFinalQaQueue(): Promise<FinalQaRow[]> {
  const { data, error } = await supabase.rpc('fm_final_qa_queue');
  if (error) throw error;
  return (data ?? []) as FinalQaRow[];
}

export async function finalQaPass(repeatId: string, note?: string | null) {
  const { data, error } = await supabase.rpc('fm_final_qa_pass', {
    p_repeat_id: repeatId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data;
}

/**
 * Raise the order's invoice. `photoUrl` is not optional in practice: the RPC
 * refuses without it, because an invoice is a money record like any other.
 */
export async function generateInvoice(args: {
  orderId: string;
  photoUrl: string;
  amount?: number | null;
  note?: string | null;
  dueDate?: string | null;
}): Promise<Invoice> {
  const { data, error } = await supabase.rpc('fm_generate_invoice', {
    p_order_id: args.orderId,
    p_amount: args.amount ?? null,
    p_note: args.note ?? null,
    p_photo_url: args.photoUrl,
    p_due_date: args.dueDate ?? null,
  });
  if (error) throw error;
  return data as Invoice;
}

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

export async function listInvoices(statuses?: string[]): Promise<Invoice[]> {
  let q = supabase
    .from('invoices')
    .select('*, orders(order_code, vendors(name))')
    .order('issued_at', { ascending: false });
  if (statuses?.length) q = q.in('status', statuses);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any;
}

export async function listPayments(direction?: 'receivable' | 'payable'): Promise<Payment[]> {
  let q = supabase.from('payments').select('*').order('paid_at', { ascending: false });
  if (direction) q = q.eq('direction', direction);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Payment[];
}

/** Proof is mandatory: `acct_record_payment` refuses a payment without one. */
export async function recordPayment(args: {
  refType: 'invoice' | 'po';
  refId: string;
  amount: number;
  proofUrl: string;
  note?: string | null;
}): Promise<Payment> {
  const { data, error } = await supabase.rpc('acct_record_payment', {
    p_ref_type: args.refType,
    p_ref_id: args.refId,
    p_amount: args.amount,
    p_proof_url: args.proofUrl ?? null,
    p_note: args.note ?? null,
  });
  if (error) throw error;
  return data as Payment;
}

export async function listExpenses(statuses?: string[]): Promise<Expense[]> {
  let q = supabase.from('expenses').select('*').order('expense_date', { ascending: false });
  if (statuses?.length) q = q.in('status', statuses);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Expense[];
}

/**
 * Record an expense. `proofUrl` is required by the RPC; `billSubtype` is
 * required when the category is `bills` and ignored otherwise — typing a name
 * that has never been used before is exactly how a new bill type is created.
 */
export async function addExpense(args: {
  category: string;
  amount: number;
  proofUrl: string;
  description?: string | null;
  recurring?: boolean;
  billSubtype?: string | null;
}): Promise<Expense> {
  const { data, error } = await supabase.rpc('acct_add_expense', {
    p_category: args.category,
    p_amount: args.amount,
    p_description: args.description ?? null,
    p_proof_url: args.proofUrl,
    p_recurring: args.recurring ?? false,
    p_bill_subtype: args.billSubtype ?? null,
  });
  if (error) throw error;
  return data as Expense;
}

/** The three-way write. One call, one transaction — never split this. */
export async function payPartner(args: {
  partnerId: string;
  amount: number;
  proofUrl: string;
  note?: string | null;
}): Promise<{ payment_id: string; expense_id: string; partner_ledger_id: string }> {
  const { data, error } = await supabase.rpc('acct_pay_partner', {
    p_partner_id: args.partnerId,
    p_amount: args.amount,
    p_proof_url: args.proofUrl ?? null,
    p_note: args.note ?? null,
  });
  if (error) throw error;
  return data as any;
}

export async function listLoans(): Promise<Loan[]> {
  const { data, error } = await supabase
    .from('loans')
    .select('*, profiles(display_name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as any;
}

export async function addLoan(args: {
  workerId: string;
  principal: number;
  installment: number;
}): Promise<Loan> {
  const { data, error } = await supabase.rpc('acct_add_loan', {
    p_worker_id: args.workerId,
    p_principal: args.principal,
    p_installment: args.installment,
  });
  if (error) throw error;
  return data as Loan;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function getApprovalsQueue(): Promise<ApprovalRow[]> {
  const { data, error } = await supabase.rpc('owner_approvals_queue');
  if (error) throw error;
  return (data ?? []) as ApprovalRow[];
}

export async function approveExpense(expenseId: string, approve: boolean, note?: string | null) {
  const { data, error } = await supabase.rpc('owner_approve_expense', {
    p_expense_id: expenseId,
    p_approve: approve,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data;
}

/** Approving worker-accountable damage is what actually reduces their pay. */
export async function approveDamage(
  damageId: string,
  approve: boolean,
  deduction?: number | null
) {
  const { data, error } = await supabase.rpc('owner_approve_damage', {
    p_damage_id: damageId,
    p_approve: approve,
    p_deduction: deduction ?? null,
  });
  if (error) throw error;
  return data as {
    approval_status: string;
    deduction_applied: number;
    responsible_type: string;
    posted: boolean;
    period: string | null;
  };
}

export async function decideSlabProposal(proposalId: string, approve: boolean) {
  const { data, error } = await supabase.rpc('owner_decide_slab_proposal', {
    p_proposal_id: proposalId,
    p_approve: approve,
  });
  if (error) throw error;
  return data;
}

export async function getDamageRecord(damageId: string) {
  const { data, error } = await supabase
    .from('damage_records')
    .select('*, orders(order_code), repeats(repeat_code), sheets(sheet_number, color_assignment)')
    .eq('id', damageId)
    .maybeSingle();
  if (error) throw error;
  return data as any;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function reportCompanyPl(from?: string, to?: string): Promise<CompanyPl | null> {
  const { data, error } = await supabase.rpc('report_company_pl', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw error;
  return ((data ?? [])[0] as CompanyPl) ?? null;
}

export async function reportOrderProfitability(orderId?: string): Promise<OrderProfit[]> {
  const { data, error } = await supabase.rpc('report_order_profitability', {
    p_order_id: orderId ?? null,
  });
  if (error) throw error;
  return (data ?? []) as OrderProfit[];
}

export async function reportInventoryLeakage(): Promise<LeakageRow[]> {
  const { data, error } = await supabase.rpc('report_inventory_leakage');
  if (error) throw error;
  return (data ?? []) as LeakageRow[];
}

export async function reportWorkerProductivity(period?: string): Promise<ProductivityRow[]> {
  const { data, error } = await supabase.rpc('report_worker_productivity', {
    p_period: period ?? null,
  });
  if (error) throw error;
  return (data ?? []) as ProductivityRow[];
}

export async function reportMachineUptime(from?: string, to?: string): Promise<UptimeRow[]> {
  const { data, error } = await supabase.rpc('report_machine_uptime', {
    p_from: from ?? null,
    p_to: to ?? null,
  });
  if (error) throw error;
  return (data ?? []) as UptimeRow[];
}

// ---------------------------------------------------------------------------
// Permission grants
// ---------------------------------------------------------------------------

export async function listUserPermissions(): Promise<
  { id: string; user_id: string; permission_key: string }[]
> {
  const { data, error } = await supabase
    .from('user_permissions')
    .select('id, user_id, permission_key');
  if (error) throw error;
  return (data ?? []) as any;
}

export async function grantPermission(userId: string, key: string) {
  const { error } = await supabase
    .from('user_permissions')
    .insert({ user_id: userId, permission_key: key });
  if (error) throw error;
}

export async function revokePermission(userId: string, key: string) {
  const { error } = await supabase
    .from('user_permissions')
    .delete()
    .eq('user_id', userId)
    .eq('permission_key', key);
  if (error) throw error;
}
