/**
 * Phase 6 — SLA alerting & final client delivery.
 *
 * WHAT USED TO BE HERE: the handoff/return/collection-QA pipeline (0020). It was
 * retired in 0063. It ran in parallel with 0056's stage loop, moved orders to
 * `in_production`/`in_finishing` without putting their repeats into the loop,
 * and stranded every repeat it did not itself touch. Those RPCs no longer exist
 * in the database, so the wrappers are gone from here too.
 *
 * What remains is the part 0056 never replaced: SLA alerts, and the final
 * handover of a finished order to the client.
 */
import { supabase } from '../client';
import type {
  HandoffQueueItem,
  ReturnQueueItem,
  CollectionQueueItem,
  FinalDeliveryItem,
  SlaAlertItem,
} from '../../models/finishingTypes';

// ---------------------------------------------------------------------------
// Handoff & Return (Delivery Person / In-house Handler)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Collection QA (QA Person & Floor Manager)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Final Delivery (Delivery Person)
// ---------------------------------------------------------------------------

export async function listFinalDeliveryQueue(): Promise<FinalDeliveryItem[]> {
  const { data, error } = await supabase.rpc('dp_final_delivery_queue');
  if (error) throw error;
  return (data ?? []) as FinalDeliveryItem[];
}

export async function completeDelivery(args: {
  orderId: string;
  deliveryPhotoUrl: string;
  deliverySignature: string;
}): Promise<{ order_id: string; status: string }> {
  const { data, error } = await supabase.rpc('dp_complete_delivery', {
    p_order_id: args.orderId,
    p_delivery_photo_url: args.deliveryPhotoUrl,
    p_delivery_signature: args.deliverySignature,
  });
  if (error) throw error;
  return data as any;
}

// ---------------------------------------------------------------------------
// SLA Alerts
// ---------------------------------------------------------------------------

export async function listSlaAlerts(): Promise<SlaAlertItem[]> {
  const { data, error } = await supabase.rpc('list_sla_alerts');
  if (error) throw error;
  return (data ?? []) as SlaAlertItem[];
}

export async function triggerSlaCheck(): Promise<number> {
  const { data, error } = await supabase.rpc('check_sla_breaches');
  if (error) throw error;
  return data as number;
}
