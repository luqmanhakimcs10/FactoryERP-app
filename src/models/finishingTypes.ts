/** Phase 6 — finishing stages, SLA alerts & final delivery models. */

export interface HandoffQueueItem {
  repeat_id: string;
  repeat_code: string;
  order_id: string;
  order_code: string;
  order_stage_id: string;
  stage_type: string;
  sequence: number;
  is_outsourced: boolean;
  sla_hours: number;
  partner_name: string | null;
  handler_name: string | null;
}

export interface ReturnQueueItem extends HandoffQueueItem {
  handed_off_at: string;
  is_breached: boolean;
}

export interface CollectionQueueItem {
  repeat_id: string;
  repeat_code: string;
  order_id: string;
  order_code: string;
  order_stage_id: string | null;
  stage_type: string | null;
  sequence: number;
  total_stages: number;
  has_partner_damage: boolean;
}

export interface FinalDeliveryItem {
  order_id: string;
  order_code: string;
  vendor_name: string;
  total_repeats: number;
  completed_repeats: number;
  created_at: string;
}

export interface SlaAlertItem {
  alert_id: string;
  repeat_id: string;
  repeat_code: string;
  order_id: string;
  order_code: string;
  order_stage_id: string;
  stage_type: string;
  partner_name: string | null;
  triggered_at: string;
  hours_overdue: number;
}
