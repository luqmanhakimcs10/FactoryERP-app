/**
 * The finishing partner's link-based portal (0086).
 *
 * These three calls are the ONLY ones in the app that run without a signed-in
 * user. They go to SECURITY DEFINER functions granted to `anon`, each of which
 * resolves the token to exactly one finishing_partners row and refuses
 * everything else. No table is exposed to `anon` — a token cannot be used to
 * read anything these three functions do not return.
 *
 * The token is passed on every call rather than being exchanged for a session:
 * there is no session to expire, no refresh to fail, and the link keeps working
 * for as long as the partner is active. Archiving the partner revokes it.
 */
import { supabase } from '../client';

export interface PartnerPortalInfo {
  partner_name: string;
  stage_type: string;
  factory_name: string;
}

export interface PartnerPortalWorkRow {
  repeat_id: string;
  repeat_code: string;
  order_code: string | null;
  vendor_name: string;
  sheet_number: number | null;
  color_assignment: string | null;
  stage_type: string | null;
  stage_sequence: number | null;
  total_stages: number;
  sla_hours: number | null;
  handed_off_at: string | null;
  sla_breached: boolean;
  partner_ready_at: string | null;
}

/** Who the link belongs to. Throws if the link has been revoked. */
export async function partnerPortalInfo(token: string): Promise<PartnerPortalInfo | null> {
  const { data, error } = await supabase.rpc('partner_portal_info', { p_token: token });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as PartnerPortalInfo | undefined;
  // No row means the token resolved but the factory itself is inactive — the
  // portal shows that as "unavailable" rather than as an empty work list.
  return row ?? null;
}

/** Everything currently in this partner's hands. */
export async function partnerPortalWork(token: string): Promise<PartnerPortalWorkRow[]> {
  const { data, error } = await supabase.rpc('partner_portal_work', { p_token: token });
  if (error) throw error;
  return (data ?? []) as PartnerPortalWorkRow[];
}

/**
 * The three numbers on the portal's metrics grid (0091).
 *
 * Same period sum `partner_get_earnings_summary` computes for the logged-in
 * view, keyed by token instead of by `auth.uid()` — a link has no session to
 * resolve a partner from.
 */
export interface PartnerPortalStats {
  active_items: number;
  completed_this_month: number;
  earnings_this_month: number;
}

export async function partnerPortalStats(token: string): Promise<PartnerPortalStats | null> {
  const { data, error } = await supabase.rpc('partner_portal_stats', {
    p_token: token,
    p_period: null,
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

/** "I have finished this piece" — the delivery person's signal to collect. */
export async function partnerPortalMarkReady(token: string, repeatId: string) {
  const { data, error } = await supabase.rpc('partner_portal_mark_ready', {
    p_token: token,
    p_repeat_id: repeatId,
  });
  if (error) throw error;
  return data;
}
