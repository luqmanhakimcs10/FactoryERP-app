/**
 * Where each task queue's items go when tapped.
 *
 * This is the ONLY place that knows a queue key maps to a screen. The database
 * returns what is pending and never where to go — a route name in SQL would
 * mean a migration every time a screen is renamed.
 *
 * Every destination below is an EXISTING screen reached by its existing params.
 * Nothing here is a simplified stand-in: the point of the banners is to reach
 * the real working screen in fewer taps, not to build a second, lesser one.
 */
import type { QueueItem } from '../api/endpoints/stageHandover';

export interface QueueRoute {
  screen: string;
  params?: Record<string, unknown>;
}

/** Heading shown above the filtered list, e.g. "Orders needing a job card". */
export const QUEUE_SCREEN_TITLE: Record<string, string> = {
  awaiting_job_card: 'Need a job card',
  accept_inventory: 'Material to accept',
  fm_collect: 'Waiting to be collected',
  fm_handover: 'Ready to hand over',
  fm_final_qa: 'Need final QA',
  fm_shift_close: 'Shifts still open',
  fm_store_handover: 'Material to hand back',
  fm_material_ready: 'Material ready to collect',
  fm_leave: 'Leave requests',
  material_requests: 'Material requests',
  grn_pending: 'Deliveries to confirm',
  sm_audit_today: 'Daily audit',
  qa_inspection: 'Need inspection',
  qa_stage: 'Need stage QA',
  qa_final: 'Need a final pass',
  dp_collect: 'Ready to collect',
  dp_send: 'Ready to send out',
  dp_pickup: 'Finished at the partner',
  dp_handback: 'To hand back',
  dp_final_delivery: 'Ready for final delivery',
  partner_active: 'With you now',
  ot_returns: 'Returns to complete',
  acct_receivables: 'Unpaid invoices',
  acct_payables: 'Bills to pay',
  owner_approvals: 'Approvals',
  po_draft: 'Purchase orders to raise',
  po_bill: 'Need a supplier bill',
  po_handover: 'To hand over',
};

/**
 * The working screen for one item.
 *
 * Returns null when the queue's destination is a screen the item cannot be
 * deep-linked into — the caller then falls back to the queue's section screen.
 * That is honest about the two cases where the action is inline on a list
 * rather than on a per-item screen (accepting material, and the delivery
 * person's own single-tab list).
 */
export function routeForItem(queueKey: string, item: QueueItem): QueueRoute | null {
  switch (queueKey) {
    // ---- Floor Manager ----
    case 'awaiting_job_card':
      // A card not yet built opens the builder; one already shared opens the
      // card itself. Same split the Orders box makes on its own rows.
      return item.status === 'awaiting_job_card'
        ? { screen: 'JobCardBuilder', params: { orderId: item.order_id } }
        : { screen: 'JobCard', params: { orderId: item.order_id } };

    case 'accept_inventory':
      // Accepting is inline on the Orders box's tab (photo + confirm per row),
      // so the deep link opens that tab rather than a per-item screen.
      return { screen: 'OrdersBox', params: { tab: 'accept_inventory' } };

    case 'fm_collect':
    case 'fm_handover':
      // Both actions live on the stage-tracking table for the order.
      return { screen: 'StageTracking', params: { orderId: item.order_id } };

    case 'fm_final_qa':
      return {
        screen: 'FinalQaDetail',
        params: { orderId: item.order_id, orderCode: item.order_code },
      };

    case 'fm_store_handover':
      // Straight into the handover form for that order — the whole point of the
      // banner is to skip the Orders box and its tab.
      return {
        screen: 'HandoverToStore',
        params: { orderId: item.order_id, orderCode: item.order_code },
      };

    case 'fm_material_ready':
      // Acknowledging is a row action on the list, not a per-order screen, so
      // there is nothing deeper to open (see routeForBanner).
      return null;

    case 'fm_shift_close':
      // secondary_id is the shift — the same param ShiftCloseQueue's own rows
      // pass, so this lands on the identical screen, not a copy of it.
      return { screen: 'ShiftClose', params: { shiftId: item.secondary_id } };

    case 'fm_leave':
      // Approve/reject are buttons on the Leave box's rows, not a per-request
      // screen, so the banner opens that box directly (see routeForBanner).
      return null;

    // ---- Store Manager ----
    case 'material_requests':
      return {
        screen: 'IssueDetail',
        params: { jobCardId: item.secondary_id, orderCode: item.order_code },
      };

    case 'grn_pending':
      return { screen: 'GrnDetail', params: { grnId: item.secondary_id } };

    case 'sm_audit_today':
      // One obligation, not a list: the banner opens the walk itself.
      return { screen: 'DailyAudit' };

    // ---- QA ----
    case 'qa_inspection':
      return item.status === 'awaiting_cloth_inspection'
        ? { screen: 'ClothInspection', params: { orderId: item.order_id } }
        : { screen: 'OrderQa', params: { orderId: item.order_id } };

    case 'qa_stage':
      return { screen: 'StageTracking', params: { orderId: item.order_id } };

    case 'qa_final':
      return { screen: 'FinalPassQueue' };

    // ---- Delivery ----
    // Every leg is actioned inline on the one Orders list this role has, so
    // there is no per-item screen to open.
    case 'dp_collect':
    case 'dp_send':
    case 'dp_pickup':
    case 'dp_handback':
    // "Ready for final delivery" is a section at the foot of that same list,
    // with the deliver action on each row.
    case 'dp_final_delivery':
      return null;

    // ---- Finishing Partner ----
    case 'partner_active':
      return null; // actioned inline on the partner dashboard's Active work tab

    // ---- Order Taker ----
    case 'ot_returns':
      return { screen: 'Returns' };

    // ---- Accountant / Owner ----
    case 'acct_receivables':
      return { screen: 'InvoiceDetail', params: { invoiceId: item.secondary_id } };

    case 'acct_payables':
      return { screen: 'Expenses' };

    case 'owner_approvals':
      return { screen: 'ApprovalDetail', params: { kind: 'expense', id: item.secondary_id } };

    // ---- Procurement ----
    // All three open the same PO screen; which button is waiting there is what
    // differs, and the PO's own status already decides that.
    case 'po_draft':
    case 'po_bill':
    case 'po_handover':
      return { screen: 'PoDetail', params: { poId: item.secondary_id } };

    default:
      return null;
  }
}

/**
 * Where the BANNER goes. Normally the filtered list; for the two queues whose
 * items are actioned inline, straight to the screen that hosts them, because a
 * list you cannot tap through from would be a dead end.
 */
export function routeForBanner(queueKey: string): QueueRoute {
  switch (queueKey) {
    case 'dp_collect':
    case 'dp_send':
    case 'dp_pickup':
    case 'dp_handback':
    case 'dp_final_delivery':
      return { screen: 'RoleHome' };
    case 'partner_active':
      return { screen: 'RoleHome' };
    case 'accept_inventory':
      return { screen: 'OrdersBox', params: { tab: 'accept_inventory' } };
    case 'fm_leave':
      return { screen: 'LeaveBox' };
    case 'sm_audit_today':
      // Nothing to filter — there is exactly one thing to do, so go and do it.
      return { screen: 'DailyAudit' };
    default:
      return { screen: 'TaskQueue', params: { queueKey } };
  }
}
