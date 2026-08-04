/**
 * Shift close + payroll API.
 *
 * Every shift transition goes through an RPC — the client never writes shifts
 * or worker_ledger directly. That is what keeps payroll trustworthy.
 */
import { supabase } from '../client';
import type {
  MachineRow,
  MachineContext,
  ShiftCloseQueueRow,
  ShiftForDateRow,
  FactoryWorker,
  WorkerLedgerEntry,
  SalaryRunSummaryRow,
  BonusSlab,
  CloseShiftResult,
  LeaveRow,
} from '../../models/shiftTypes';
import type { Order } from '../../models/orderTypes';

// ---------------------------------------------------------------------------
// Floor manager
// ---------------------------------------------------------------------------

export async function listMachines(): Promise<MachineRow[]> {
  const { data, error } = await supabase.rpc('fm_list_machines');
  if (error) throw error;
  return (data ?? []) as MachineRow[];
}

export async function getMachineContext(machineId: string): Promise<MachineContext> {
  const { data, error } = await supabase.rpc('fm_machine_context', {
    p_machine_id: machineId,
  });
  if (error) throw error;
  return data as MachineContext;
}

export async function listFactoryWorkers(): Promise<FactoryWorker[]> {
  const { data, error } = await supabase.rpc('list_factory_workers');
  if (error) throw error;
  return (data ?? []) as FactoryWorker[];
}

export async function openShift(params: {
  machineId: string;
  workerId: string;
  orderId: string | null;
  openPhotoUrl: string;
  openStitches: number;
  workerPhotoUrl: string;
  reportedStartTime?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('fm_open_shift', {
    p_machine_id: params.machineId,
    p_worker_id: params.workerId,
    p_order_id: params.orderId,
    p_open_photo_url: params.openPhotoUrl,
    p_open_stitches: params.openStitches,
    p_worker_photo_url: params.workerPhotoUrl,
    p_reported_start_time: params.reportedStartTime ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function listShiftCloseQueue(): Promise<ShiftCloseQueueRow[]> {
  const { data, error } = await supabase.rpc('fm_shift_close_queue');
  if (error) throw error;
  return (data ?? []) as ShiftCloseQueueRow[];
}

export async function getShift(shiftId: string) {
  const { data, error } = await supabase
    .from('shifts')
    .select('*, machines(name), profiles!shifts_worker_id_fkey(display_name)')
    .eq('id', shiftId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function flagShiftIdle(
  shiftId: string,
  closePhotoUrl?: string,
  detectedStitches?: number
): Promise<void> {
  const { error } = await supabase.rpc('fm_flag_shift_idle', {
    p_shift_id: shiftId,
    p_close_photo_url: closePhotoUrl ?? null,
    p_detected_stitches: detectedStitches ?? null,
  });
  if (error) throw error;
}

export async function closeShift(params: {
  shiftId: string;
  closePhotoUrl: string;
  detectedStitches: number;
  confirmedStitches: number;
  downtimeMinutes?: number | null;
  downtimeReason?: string | null;
}): Promise<CloseShiftResult> {
  const { data, error } = await supabase.rpc('fm_close_shift', {
    p_shift_id: params.shiftId,
    p_close_photo_url: params.closePhotoUrl,
    p_detected_stitches: params.detectedStitches,
    p_confirmed_stitches: params.confirmedStitches,
    p_downtime_minutes: params.downtimeMinutes ?? null,
    p_downtime_reason: params.downtimeReason ?? null,
  });
  if (error) throw error;
  return data as CloseShiftResult;
}

// ---------------------------------------------------------------------------
// Floor manager: leave approval
// ---------------------------------------------------------------------------

export async function listFactoryLeaves(status?: string): Promise<LeaveRow[]> {
  let q = supabase
    .from('leaves')
    .select('*, profiles!leaves_worker_id_fkey(display_name)')
    .order('requested_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any;
}

export async function decideLeave(leaveId: string, approve: boolean): Promise<LeaveRow> {
  const { data, error } = await supabase.rpc('fm_decide_leave', {
    p_leave_id: leaveId,
    p_approve: approve,
  });
  if (error) throw error;
  return data as LeaveRow;
}

// ---------------------------------------------------------------------------
// Accountant
// ---------------------------------------------------------------------------

export async function salaryRunSummary(period?: string): Promise<SalaryRunSummaryRow[]> {
  const { data, error } = await supabase.rpc('acct_salary_run_summary', {
    p_period: period ?? null,
  });
  if (error) throw error;
  return (data ?? []) as SalaryRunSummaryRow[];
}

export async function workerLedgerEntries(
  workerId: string,
  period?: string
): Promise<WorkerLedgerEntry[]> {
  const { data, error } = await supabase.rpc('acct_worker_ledger_entries', {
    p_worker_id: workerId,
    p_period: period ?? null,
  });
  if (error) throw error;
  return (data ?? []) as WorkerLedgerEntry[];
}

export async function finalizeSalaryRun(
  period?: string,
  workerIds?: string[]
): Promise<{ finalized_count: number; period: string }> {
  const { data, error } = await supabase.rpc('acct_finalize_salary_run', {
    p_period: period ?? null,
    p_worker_ids: workerIds ?? null,
  });
  if (error) throw error;
  return data as { finalized_count: number; period: string };
}

export async function attachPaymentProof(
  ledgerIds: string[],
  proofUrl: string
): Promise<{ updated_count: number }> {
  const { data, error } = await supabase.rpc('acct_attach_payment_proof', {
    p_ledger_ids: ledgerIds,
    p_payment_proof_url: proofUrl,
  });
  if (error) throw error;
  return data as { updated_count: number };
}

// ---------------------------------------------------------------------------
// Owner: bonus slabs
// ---------------------------------------------------------------------------

export async function listBonusSlabs(): Promise<BonusSlab[]> {
  const { data, error } = await supabase
    .from('bonus_slabs')
    .select('*')
    .order('daily_stitch_threshold');
  if (error) throw error;
  return (data ?? []) as BonusSlab[];
}

export async function upsertBonusSlab(params: {
  id?: string;
  dailyStitchThreshold: number;
  bonusAmount: number;
}): Promise<string> {
  const { data, error } = await supabase.rpc('owner_upsert_bonus_slab', {
    p_id: params.id ?? null,
    p_daily_stitch_threshold: params.dailyStitchThreshold,
    p_bonus_amount: params.bonusAmount,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteBonusSlab(id: string): Promise<void> {
  const { error } = await supabase.rpc('owner_delete_bonus_slab', { p_id: id });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Machine assignment (Stage 6)
// ---------------------------------------------------------------------------

export async function assignMachine(orderId: string, machineId: string): Promise<Order> {
  const { data, error } = await supabase.rpc('fm_assign_machine', {
    p_order_id: orderId,
    p_machine_id: machineId,
  });
  if (error) throw error;
  return data as Order;
}

/** Shift Calendar: per-machine shift state for one date (YYYY-MM-DD). */
export async function listShiftsForDate(date: string): Promise<ShiftForDateRow[]> {
  const { data, error } = await supabase.rpc('fm_shifts_for_date', { p_date: date });
  if (error) throw error;
  return (data ?? []) as ShiftForDateRow[];
}

// Orders eligible for machine assignment (in production).
/**
 * Orders a shift can be opened against.
 *
 * `machine_selection_pending` was MISSING and is the whole point of this list:
 * accepting inventory (0041's `fm_accept_inventory`) moves an order from
 * `job_card_confirmed` to exactly that status, so the orders most ready for a
 * machine were the only ones the picker excluded. ALP-00098 sat in the Accept
 * Inventory queue and could not be selected here.
 *
 * The other three are kept: `job_card_confirmed` for a shift opened before
 * materials are accepted, and the two in-flight statuses so a second machine
 * can join an order already running.
 */
export async function listAssignableOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('id, order_code, vendor_name:vendors(name)')
    .in('status', [
      'job_card_confirmed',
      'machine_selection_pending',
      'in_production',
      'in_finishing',
    ])
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}
