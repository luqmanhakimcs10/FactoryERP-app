/**
 * Phase 8 — Worker & Finishing Partner dashboard types.
 * Shapes match the RPC return tables in 0022_phase8_dashboard_schema.sql.
 */
import type { WorkerLedgerEntry } from './shiftTypes';

/** Most recent worker ledger row (current period headline). */
export interface WorkerLedgerSummary {
  id: string;
  period: string;
  stitch_count: number;
  base_per_stitch: number;
  bonus: number;
  damage_deduction: number;
  loan_installment: number;
  net: number;
  status: 'pending' | 'finalized';
  payment_proof_url: string | null;
  finalized_at: string | null;
  created_at: string;
}

export interface WorkerLoan {
  id: string;
  principal: number;
  balance: number;
  installment_amount: number;
  status: 'active' | 'paid_off';
  created_at: string;
}

export interface LeaveRecord {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  start_date: string;
  end_date: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

/** The worker's current (or most recent) shift, for downtime reporting. */
export interface WorkerShiftRef {
  id: string;
  machine_id: string;
  machine_name: string;
  order_id: string | null;
  order_code: string | null;
  opened_at: string;
  status: 'open' | 'closed' | 'flagged_idle';
}

export interface PartnerEarningsSummary {
  total_earnings: number;
  total_damage_charges: number;
  total_payments: number;
  net_receivable: number;
}

export interface PartnerCompletedWork {
  repeat_id: string;
  repeat_code: string;
  order_code: string | null;
  stage_type: string;
  completed_at: string | null;
  stitch_count: number;
  earning_amount: number;
}

export interface PartnerDamageCharge {
  id: string;
  repeat_code: string;
  order_code: string | null;
  stage_type: string;
  damage_type: string;
  amount: number;
  photo_url: string | null;
  note: string | null;
  created_at: string;
}

export interface PartnerPayment {
  id: string;
  amount: number;
  period: string;
  created_at: string;
  created_by_name: string | null;
}

export type { WorkerLedgerEntry };
