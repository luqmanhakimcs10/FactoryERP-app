/** Phase 3 — order spine types. */
import type { StageType } from './types';

export type OrderStatus =
  | 'draft'
  | 'awaiting_procurement'
  | 'awaiting_cloth_inspection'
  | 'awaiting_coding'
  | 'awaiting_job_card'
  | 'job_card_shared'
  | 'job_card_confirmed'
  | 'machine_selection_pending'
  | 'in_production'
  | 'in_finishing'
  | 'awaiting_final_qa'
  | 'ready_for_delivery'
  | 'completed'
  | 'cancelled';

/**
 * Repeat status values. This mirrors `repeats.current_status`, which is a
 * DENORMALIZED CACHE of the newest repeat_stage_history row — read history when
 * you need provenance (who/when/photo), read this only to filter lists.
 */
export type RepeatStatus =
  | 'coded'
  | 'awaiting_job_card'
  | 'ready_for_production'
  /** Retired by 0056 — a stage now opens at in_progress on its own. Still
   *  appears in historical `repeat_stage_history` rows, so it stays in the
   *  union for anything rendering that history. */
  | 'awaiting_stage'
  | 'in_progress'
  | 'stage_qa'
  // ---- the delivery round trip, one per stage (0056) ----
  | 'handover_for_delivery'
  | 'awaiting_dp_collection'
  | 'handed_over'
  | 'handed_off'
  | 'returned_to_delivery'
  | 'awaiting_fm_collection'
  | 'in_production'
  | 'in_finishing'
  | 'awaiting_collection_qa'
  // ---- the two final gates (0056) ----
  | 'awaiting_final_qa'
  | 'awaiting_qa_final'
  | 'completed'
  | 'damaged';

export type JobCardStatus = 'draft' | 'shared' | 'confirmed';
export type DamageType = 'fabric' | 'stains' | 'cutting' | 'size' | 'other';
export type ResponsibleType = 'vendor' | 'worker' | 'partner';

export interface Order {
  id: string;
  factory_id: string;
  vendor_id: string;
  order_number: number | null;
  order_code: string | null;
  status: OrderStatus;
  cloth_photos: string[];
  design_sheet_url: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  inspected_at: string | null;
  assigned_machine_id: string | null;
  vendors?: { name: string; contact?: string | null; address?: string | null };
}

export interface OrderListRow extends Order {
  vendor_name: string;
  sheet_count: number;
  repeat_total: number;
}

export interface Sheet {
  id: string;
  factory_id: string;
  order_id: string;
  sheet_number: number;
  color_assignment: string;
  repeats_count: number;
  thread_color_codes: string[];
  stitch_count: number;
  created_at: string;
}

export interface OrderStage {
  id: string;
  factory_id: string;
  order_id: string;
  stage_type: StageType;
  sequence: number;
  is_outsourced: boolean;
  sla_hours: number;
  handler_user_id: string | null;
  partner_id: string | null;
  finishing_partners?: { name: string } | null;
}

export interface Repeat {
  id: string;
  factory_id: string;
  sheet_id: string;
  repeat_number: number;
  repeat_code: string;
  current_status: RepeatStatus;
  current_stage_index: number;
  created_at: string;
  updated_at: string;
  sheets?: { order_id: string; sheet_number: number; color_assignment: string };
}

/** Append-only. The source of truth for a repeat's position. */
export interface RepeatStageHistory {
  id: string;
  factory_id: string;
  repeat_id: string;
  order_stage_id: string | null;
  status: string;
  actor_user_id: string | null;
  photo_url: string | null;
  note: string | null;
  created_at: string;
  profiles?: { display_name: string } | null;
  order_stages?: { stage_type: StageType; sequence: number } | null;
}

export interface JobCard {
  id: string;
  factory_id: string;
  order_id: string;
  status: JobCardStatus;
  change_notes: string | null;
  revision: number;
  shared_at: string | null;
  confirmed_at: string | null;
  vendor_informed_at: string | null;
  material_requested_at: string | null;
  design_code: string | null;
  stitches_per_repeat: number | null;
  created_at: string;
}

export interface JobCardLine {
  id: string;
  job_card_id: string;
  sheet_id: string | null;
  needle_number: number;
  thread_color_code: string;
  stitch_count: number | null;
}

export interface DamageRecord {
  id: string;
  factory_id: string;
  order_id: string;
  sheet_id: string | null;
  repeat_id: string | null;
  stage_type: string;
  damage_type: DamageType;
  responsible_type: ResponsibleType;
  responsible_id: string | null;
  deduction: number;
  approved_by: string | null;
  approved_at: string | null;
  photo_url: string | null;
  note: string | null;
  created_at: string;
  ot_return_confirmed_at?: string | null;
  /**
   * Only meaningful for `stage_type: 'repeat_qa'` rows — where a rejected piece
   * is in its return round trip (0059). Null on every other kind of damage
   * record, which never leaves the factory.
   */
  recheck_state?:
    | 'awaiting_return'
    | 'awaiting_recheck'
    | 'passed'
    | 'superseded'
    | 'written_off'
    | null;
  sheets?: { sheet_number: number; color_assignment: string } | null;
  repeats?: { repeat_code: string } | null;
  orders?: { order_code: string | null } | null;
}

export interface PurchaseOrder {
  id: string;
  factory_id: string;
  po_code: string;
  order_id: string | null;
  supplier_id: string | null;
  status: string;
  auto_created: boolean;
  created_at: string;
  po_items?: { color_code: string; quantity_meters: number }[];
}

/** One row of the stitch-line timeline. */
export interface TimelineStep {
  step_key: string;
  label: string;
  state: 'done' | 'current' | 'ahead';
  at: string | null;
  detail: string | null;
}

// ---- RPC inputs ----

export interface SheetInput {
  color_assignment: string;
  repeats_count: number;
  thread_color_codes: string[];
  stitch_count: number;
}

export interface StageInput {
  stage_type: StageType;
  is_outsourced: boolean;
  sla_hours: number;
  partner_id?: string | null;
  handler_user_id?: string | null;
}

export interface SubmitResult {
  order_id: string;
  status: 'awaiting_procurement' | 'awaiting_cloth_inspection';
  shortfalls: {
    color_code: string;
    required_meters: number;
    available_meters: number;
    shortfall_meters: number;
  }[];
  purchase_order_id: string | null;
  po_code: string | null;
}

// ---- Display helpers ----

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  draft: 'Draft',
  awaiting_procurement: 'Awaiting Procurement',
  awaiting_cloth_inspection: 'Awaiting Cloth Inspection',
  awaiting_coding: 'Awaiting QA Coding',
  awaiting_job_card: 'Awaiting Job Card',
  job_card_shared: 'Job Card Shared',
  job_card_confirmed: 'Job Card Confirmed',
  machine_selection_pending: 'Machine Selection Pending',
  in_production: 'In Production',
  in_finishing: 'In Finishing',
  awaiting_final_qa: 'Awaiting Final QA',
  ready_for_delivery: 'Ready for Delivery',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const DAMAGE_TYPE_LABEL: Record<DamageType, string> = {
  fabric: 'Fabric damage',
  stains: 'Stains',
  cutting: 'Cutting',
  size: 'Size mismatch',
  other: 'Other',
};
