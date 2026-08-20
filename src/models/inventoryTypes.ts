/** Phase 4 — inventory & procurement types. */

/**
 * A purchase order's status (0089).
 *
 * THREE LIVE ONES — Creation (`auto_generated`/`draft`), `procured`, `paid` —
 * plus `received` once the store manager checks the goods in, and `cancelled`.
 *
 * The four below the line are RETIRED. Nothing writes them any more: the store
 * manager procures and the accountant pays, with no owner approval and no
 * separate handover press. They stay in the union because rows created before
 * 0089 still carry them and the app has to render those without crashing.
 */
export type PoStatus =
  | 'auto_generated'
  | 'draft'
  | 'procured'
  | 'paid'
  | 'received'
  | 'cancelled'
  // Retired — historical rows only.
  | 'executed'
  | 'awaiting_approval'
  | 'approved'
  | 'handed_over';

/** The three the PO detail screen shows as a progress track. */
export const PO_FLOW: { key: 'creation' | 'procured' | 'paid'; label: string }[] = [
  { key: 'creation', label: 'Creation' },
  { key: 'procured', label: 'Procured' },
  { key: 'paid', label: 'Paid' },
];

/** Which of the three steps a status sits at — retired statuses map onto the new ones. */
export function poFlowStep(status: PoStatus): 0 | 1 | 2 {
  if (status === 'auto_generated' || status === 'draft') return 0;
  if (status === 'procured' || status === 'executed'
      || status === 'awaiting_approval' || status === 'approved') return 1;
  return 2; // paid / handed_over / received / cancelled
}

export type GrnStatus = 'pending' | 'confirmed' | 'rejected';

/**
 * `opening` is not in the original brief's list. It exists because the opening
 * balance must live in the ledger too — without it a running sum starts from
 * nothing and can never reconcile to the real balance.
 */
export type MovementType = 'opening' | 'grn' | 'issue' | 'audit_variance';

export interface ThreadStock {
  id: string;
  factory_id: string;
  color_code: string;
  color_name?: string | null;
  photo_url?: string | null;
  quantity_meters: number;
  reorder_threshold: number | null;
  reorder_quantity: number | null;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrder {
  id: string;
  factory_id: string;
  po_code: string;
  order_id: string | null;
  supplier_id: string | null;
  status: PoStatus;
  auto_created: boolean;
  bill_url: string | null;
  amount: number | null;
  notes: string | null;
  executed_at: string | null;
  /** Set when the store manager marks it Procured (0089). */
  procured_at?: string | null;
  procured_by?: string | null;
  approved_at: string | null;
  paid_at: string | null;
  created_at: string;
  suppliers?: { name: string } | null;
  orders?: { order_code: string | null } | null;
  po_items?: PoItem[];
}

export interface PoItem {
  id: string;
  purchase_order_id: string;
  color_code: string | null;
  description: string | null;
  quantity_meters: number;
}

export interface Grn {
  id: string;
  factory_id: string;
  grn_code: string;
  purchase_order_id: string | null;
  status: GrnStatus;
  handed_over_at: string;
  confirmed_at: string | null;
  note: string | null;
  purchase_orders?: { po_code: string; suppliers?: { name: string } | null } | null;
  grn_items?: GrnItem[];
}

export interface GrnItem {
  id: string;
  grn_id: string;
  color_code: string | null;
  description: string | null;
  expected_meters: number;
  received_meters: number;
}

export interface MaterialIssueQueueRow {
  job_card_id: string;
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  confirmed_at: string;
  colors: number;
  total_meters: number;
}

export interface JobCardRequirement {
  color_code: string;
  required_meters: number;
  available_meters: number;
  sufficient: boolean;
}

export interface StockLedgerRow {
  created_at: string;
  movement_type: MovementType;
  quantity_meters: number;
  balance_after: number;
  actor: string;
  ref_type: string | null;
  ref_code: string | null;
  note: string | null;
}

export interface StockAudit {
  id: string;
  audit_code: string;
  audit_date: string;
  submitted_at: string;
  note: string | null;
  stock_audit_items?: {
    color_code: string;
    expected_meters: number;
    actual_meters: number;
    variance_meters: number;
  }[];
}

export interface MaterialIssue {
  id: string;
  issue_code: string;
  job_card_id: string;
  order_id: string;
  issued_at: string;
  note: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  accepted_photo_url: string | null;
  orders?: { order_code: string | null } | null;
  material_issue_items?: {
    color_code: string;
    required_meters: number;
    issued_meters: number;
  }[];
}

/**
 * One line on a material issue, as the Floor Manager ticks it off (0084).
 *
 * `item_type` and `unit` come from the `inventory_items` row the line draws on,
 * not from the issue — one definition of what a colour code IS, so a line can
 * never describe its stock item differently from the stock screen.
 */
export interface MaterialIssueLine {
  item_id: string;
  color_code: string;
  item_type: string;
  unit: string;
  required_meters: number;
  issued_meters: number;
  received_at: string | null;
}

/** A material issue not yet accepted by the floor manager — the pickup queue. */
export interface PendingMaterialIssueRow {
  material_issue_id: string;
  order_id: string;
  order_code: string | null;
  vendor_name: string;
  issued_by_name: string;
  issued_at: string;
  colors: number;
  total_meters: number;
}

// ---- Display ----

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  auto_generated: 'Creation',
  draft: 'Creation',
  procured: 'Procured',
  paid: 'Paid',
  received: 'Received',
  cancelled: 'Cancelled',
  // Retired (0089). Labelled as the step they collapsed into, so a historical
  // row reads as part of the same three-status flow rather than as a fourth
  // state nobody recognises.
  executed: 'Procured',
  awaiting_approval: 'Procured',
  approved: 'Procured',
  handed_over: 'Paid',
};

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  opening: 'Opening',
  grn: 'Receipt',
  issue: 'Issue',
  audit_variance: 'Audit',
};
