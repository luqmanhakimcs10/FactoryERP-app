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
  material_requests: 'Material requests',
  grn_pending: 'Deliveries to confirm',
  qa_inspection: 'Need inspection',
  qa_stage: 'Need stage QA',
  qa_final: 'Need a final pass',
  dp_collect: 'Ready to collect',
  dp_send: 'Ready to send out',
  dp_pickup: 'Finished at the partner',
  dp_handback: 'To hand back',
  partner_active: 'With you now',
  ot_returns: 'Returns to complete',
  acct_receivables: 'Unpaid invoices',
  acct_payables: 'Bills to pay',
  owner_approvals: 'Approvals',
  po_draft: 'Purchase orders to raise',
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

    // ---- Store Manager ----
    case 'material_requests':
      return {
        screen: 'IssueDetail',
        params: { jobCardId: item.secondary_id, orderCode: item.order_code },
      };

    case 'grn_pending':
      return { screen: 'GrnDetail', params: { grnId: item.secondary_id } };

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
    case 'po_draft':
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
      return { screen: 'RoleHome' };
    case 'partner_active':
      return { screen: 'RoleHome' };
    case 'accept_inventory':
      return { screen: 'OrdersBox', params: { tab: 'accept_inventory' } };
    default:
      return { screen: 'TaskQueue', params: { queueKey } };
  }
}
