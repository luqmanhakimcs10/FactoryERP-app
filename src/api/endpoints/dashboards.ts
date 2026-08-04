/**
 * Phase 8 — Worker & Finishing Partner dashboard API.
 *
 * Every call wraps a SECURITY DEFINER RPC from 0022_phase8_dashboard_schema.sql
 * (plus 0028 for the earning postings those dashboards read). The RPCs scope to
 * the caller: a worker only ever sees their own rows, a partner their own ledger.
 */
import { supabase } from '../client';
import type {
  WorkerLedgerSummary,
  WorkerLoan,
  LeaveRecord,
  WorkerShiftRef,
  PartnerEarningsSummary,
  PartnerCompletedWork,
  PartnerDamageCharge,
  PartnerPayment,
} from '../../models/dashboardTypes';
import type { WorkerLedgerEntry } from '../../models/shiftTypes';

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export async function getWorkerLatestLedger(): Promise<WorkerLedgerSummary | null> {
  const { data, error } = await supabase.rpc('worker_get_latest_ledger');
  if (error) throw error;
  return ((data ?? [])[0] as WorkerLedgerSummary) ?? null;
}

export async function getWorkerLedgerEntries(period?: string): Promise<WorkerLedgerEntry[]> {
  const { data, error } = await supabase.rpc('worker_get_ledger_entries', {
    p_period: period ?? null,
  });
  if (error) throw error;
  return (data ?? []) as WorkerLedgerEntry[];
}

export async function getWorkerActiveLoan(): Promise<WorkerLoan | null> {
  const { data, error } = await supabase.rpc('worker_get_active_loan');
  if (error) throw error;
  return ((data ?? [])[0] as WorkerLoan) ?? null;
}

export async function getWorkerLeaveHistory(): Promise<LeaveRecord[]> {
  const { data, error } = await supabase.rpc('worker_get_leave_history');
  if (error) throw error;
  return (data ?? []) as LeaveRecord[];
}

export async function submitWorkerLeave(args: {
  reason: string;
  startDate: string;
  endDate: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('worker_submit_leave', {
    p_reason: args.reason,
    p_start_date: args.startDate,
    p_end_date: args.endDate,
  });
  if (error) throw error;
  return data as string;
}

export async function getWorkerCurrentShift(): Promise<WorkerShiftRef | null> {
  const { data, error } = await supabase.rpc('worker_get_current_shift');
  if (error) throw error;
  return ((data ?? [])[0] as WorkerShiftRef) ?? null;
}

export async function reportDowntime(args: {
  shiftId: string;
  durationMinutes: number;
  reason: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('worker_report_downtime', {
    p_shift_id: args.shiftId,
    p_duration_minutes: args.durationMinutes,
    p_reason: args.reason,
  });
  if (error) throw error;
  return data as string;
}

// ---------------------------------------------------------------------------
// Finishing Partner
// ---------------------------------------------------------------------------

export async function getPartnerEarningsSummary(period?: string): Promise<PartnerEarningsSummary | null> {
  const { data, error } = await supabase.rpc('partner_get_earnings_summary', {
    p_period: period ?? null,
  });
  if (error) throw error;
  return ((data ?? [])[0] as PartnerEarningsSummary) ?? null;
}

export async function getPartnerCompletedWork(period?: string): Promise<PartnerCompletedWork[]> {
  const { data, error } = await supabase.rpc('partner_get_completed_work', {
    p_period: period ?? null,
  });
  if (error) throw error;
  return (data ?? []) as PartnerCompletedWork[];
}

export async function getPartnerDamageCharges(period?: string): Promise<PartnerDamageCharge[]> {
  const { data, error } = await supabase.rpc('partner_get_damage_charges', {
    p_period: period ?? null,
  });
  if (error) throw error;
  return (data ?? []) as PartnerDamageCharge[];
}

export async function getPartnerPaymentHistory(): Promise<PartnerPayment[]> {
  const { data, error } = await supabase.rpc('partner_get_payment_history');
  if (error) throw error;
  return (data ?? []) as PartnerPayment[];
}
