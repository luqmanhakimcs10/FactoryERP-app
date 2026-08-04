/** Shift close + payroll domain types. */

export type ShiftStatus = 'open' | 'closed' | 'flagged_idle';

export interface Shift {
  id: string;
  factory_id: string;
  machine_id: string;
  worker_id: string;
  order_id: string | null;
  open_panel_photo_url: string;
  open_stitches: number;
  close_panel_photo_url: string | null;
  detected_stitches: number | null;
  confirmed_stitches: number | null;
  status: ShiftStatus;
  opened_at: string;
  closed_at: string | null;
}

export interface MachineRow {
  id: string;
  name: string;
  has_open_shift: boolean;
  open_shift_id: string | null;
  worker_name: string | null;
  order_code: string | null;
}

export interface ShiftForDateRow {
  machine_id: string;
  machine_name: string;
  shift_id: string | null;
  status: 'open' | 'closed' | 'flagged_idle' | null;
  worker_name: string | null;
  order_code: string | null;
  opened_at: string | null;
  closed_at: string | null;
}

export interface MachineContext {
  machine_id: string;
  machine_name: string;
  has_open_shift: boolean;
  previous_order_id: string | null;
  previous_job_card_lines: JobCardLineRef[];
  inherited_open_photo_url: string | null;
  inherited_open_stitches: number;
}

export interface JobCardLineRef {
  needle_number: number;
  thread_color_code: string;
  stitch_count: number | null;
}

export interface ShiftCloseQueueRow {
  shift_id: string;
  machine_id: string;
  machine_name: string;
  worker_name: string;
  order_code: string | null;
  opened_at: string;
}

export interface FactoryWorker {
  id: string;
  display_name: string;
  stitch_rate: number | null;
}

export interface WorkerLedgerEntry {
  id: string;
  factory_id: string;
  worker_id: string;
  shift_id: string | null;
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

export interface SalaryRunSummaryRow {
  worker_id: string;
  worker_name: string;
  entry_count: number;
  total_stitches: number;
  total_base: number;
  total_bonus: number;
  total_deduction: number;
  total_loan: number;
  total_net: number;
  has_pending: boolean;
  /** How this employee is paid (0030): per_stitch / per_day / per_month. */
  salary_type: string | null;
}

export interface BonusSlab {
  id: string;
  factory_id: string;
  daily_stitch_threshold: number;
  bonus_amount: number;
  created_at: string;
  updated_at: string;
}

export interface CloseShiftResult {
  shift_id: string;
  ledger_id: string;
  stitch_count: number;
  base_amount: number;
  bonus: number;
  net: number;
}

export type LeaveStatus = 'pending' | 'approved' | 'rejected';

export interface LeaveRow {
  id: string;
  worker_id: string;
  status: LeaveStatus;
  reason: string;
  start_date: string;
  end_date: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  profiles?: { display_name: string } | null;
}

/** Steps in the shift-close screen state machine. */
export type ShiftCloseStep =
  | 'camera'
  | 'uploading'
  | 'detecting'
  | 'review'
  | 'correct'
  | 'downtime'
  | 'closing';

export interface PendingShiftCapture {
  shiftId: string;
  localUri: string;
  step: 'upload' | 'detect';
  storagePath?: string;
  detectedCount?: number;
  savedAt: string;
}
