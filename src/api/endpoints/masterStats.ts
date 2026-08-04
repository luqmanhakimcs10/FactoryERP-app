/**
 * Masters tab stat panels — factory-wide aggregates read live from the
 * transaction tables (orders, invoices, payments, POs, shifts, repeats,
 * partner_ledger), computed in 0030's SECURITY DEFINER functions so RLS never
 * needs to be broadened for a read-only summary.
 */
import { supabase } from '../client';

export interface MasterStatRow {
  total_clients?: number;
  active_orders?: number;
  invoiced?: number;
  collected?: number;
  remaining?: number;
  total_suppliers?: number;
  open_pos?: number;
  po_value?: number;
  paid?: number;
  total_machines?: number;
  active_7d?: number;
  shifts_closed?: number;
  uptime_pct?: number;
  downtime_minutes?: number;
  total_partners?: number;
  repeats_in_hand?: number;
  handed_off_total?: number;
  revenue?: number;
  income?: number;
  damage_count?: number;
  total_employees?: number;
  active_employees?: number;
  per_month?: number;
  per_day?: number;
  per_stitch?: number;
  [key: string]: unknown;
}

async function single(rpc: string, args?: Record<string, unknown>): Promise<MasterStatRow[]> {
  const { data, error } = await supabase.rpc(rpc, args ?? {});
  if (error) throw error;
  return (data ?? []) as MasterStatRow[];
}

export function clientStats(): Promise<MasterStatRow[]> {
  return single('master_client_stats');
}

export function supplierStats(): Promise<MasterStatRow[]> {
  return single('master_supplier_stats');
}

export function machineStats(): Promise<MasterStatRow[]> {
  return single('master_machine_stats');
}

export function partnerStats(): Promise<MasterStatRow[]> {
  return single('master_partner_stats');
}
