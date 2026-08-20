/**
 * Factories & modules API. RLS scopes every read to the caller's own factory
 * (super_admin excepted). No component touches supabase directly.
 */
import { supabase } from '../client';
import type {
  Factory,
  FactoryModule,
  Module,
  FactoryInvoiceStatus,
  SaBillingSummary,
  SaFactoryListRow,
  SaInvoiceRow,
  SaFactoryModuleRow,
  SubscriptionStatus,
} from '../../models/types';
import type { ModuleKey } from '../../constants/roles';

/** The caller's own factory (single-tenant session). */
export async function getMyFactory(factoryId: string): Promise<Factory | null> {
  const { data, error } = await supabase
    .from('factories')
    .select('*')
    .eq('id', factoryId)
    .maybeSingle();

  if (error) throw error;
  return (data as Factory) ?? null;
}

/** Which modules are enabled for a factory (drives client-side module gating hint). */
export async function getEnabledModuleKeys(factoryId: string): Promise<ModuleKey[]> {
  const { data, error } = await supabase
    .from('factory_modules')
    .select('enabled, modules(key)')
    .eq('factory_id', factoryId)
    .eq('enabled', true);

  if (error) throw error;
  return (data ?? [])
    .map((row: any) => row.modules?.key as ModuleKey)
    .filter(Boolean);
}

/** Super-admin only: list all factories (RLS enforces the super_admin check). */
export async function listAllFactories(): Promise<Factory[]> {
  const { data, error } = await supabase.from('factories').select('*').order('name');
  if (error) throw error;
  return (data as Factory[]) ?? [];
}

/** Whether the signed-in user's factory account is active. Super admin always true. */
export async function isMyFactoryActive(): Promise<boolean> {
  const { data, error } = await supabase.rpc('my_factory_active');
  if (error) throw error;
  return data === true;
}

// ---- Super Admin RPCs (0028) ----

export async function saFactoryList(): Promise<SaFactoryListRow[]> {
  const { data, error } = await supabase.rpc('sa_factory_list');
  if (error) throw error;
  return (data as SaFactoryListRow[]) ?? [];
}

export async function saCreateFactory(input: {
  name: string;
  representative_name?: string;
  phone?: string;
  address?: string;
  subscription_amount?: number;
  module_keys: ModuleKey[];
  next_billing_date?: string | null;
}): Promise<Factory> {
  const { data, error } = await supabase.rpc('sa_create_factory', {
    p_name: input.name,
    p_representative_name: input.representative_name ?? null,
    p_phone: input.phone ?? null,
    p_address: input.address ?? null,
    p_subscription_amount: input.subscription_amount ?? 0,
    p_module_keys: input.module_keys,
    p_next_billing_date: input.next_billing_date ?? null,
  });
  if (error) throw error;
  return data as Factory;
}

export async function saUpdateFactory(
  factoryId: string,
  input: {
    representative_name?: string;
    phone?: string;
    address?: string;
    subscription_amount?: number;
    subscription_status?: SubscriptionStatus;
    next_billing_date?: string | null;
  }
): Promise<Factory> {
  const { data, error } = await supabase.rpc('sa_update_factory', {
    p_factory_id: factoryId,
    p_representative_name: input.representative_name ?? null,
    p_phone: input.phone ?? null,
    p_address: input.address ?? null,
    p_subscription_amount: input.subscription_amount ?? null,
    p_subscription_status: input.subscription_status ?? null,
    p_next_billing_date: input.next_billing_date ?? null,
  });
  if (error) throw error;
  return data as Factory;
}

export async function saSetAccountStatus(factoryId: string, active: boolean): Promise<Factory> {
  const { data, error } = await supabase.rpc('sa_set_account_status', {
    p_factory_id: factoryId,
    p_active: active,
  });
  if (error) throw error;
  return data as Factory;
}

export async function saFactoryModules(factoryId: string): Promise<SaFactoryModuleRow[]> {
  const { data, error } = await supabase.rpc('sa_factory_modules', {
    p_factory_id: factoryId,
  });
  if (error) throw error;
  return (data as SaFactoryModuleRow[]) ?? [];
}

export async function saToggleModule(
  factoryId: string,
  moduleKey: ModuleKey,
  enabled: boolean
): Promise<void> {
  const { error } = await supabase.rpc('sa_toggle_module', {
    p_factory_id: factoryId,
    p_module_key: moduleKey,
    p_enabled: enabled,
  });
  if (error) throw error;
}

// ---- Platform billing (0085) ----
//
// There is no longer any inventory reader here. `saFactoryInventory` and
// `saLastAudit` were removed with their RPCs: Super Admin has no access to a
// factory's stock, in any form, on any screen.

/**
 * Invoice rows. One function, three callers:
 *   - Invoice History tab      -> no arguments
 *   - Billing "Pending" sub-tab -> status 'pending'
 *   - a factory's Payment History -> that factory's id
 */
export async function saInvoiceList(args?: {
  status?: FactoryInvoiceStatus;
  factoryId?: string;
}): Promise<SaInvoiceRow[]> {
  const { data, error } = await supabase.rpc('sa_invoice_list', {
    p_status: args?.status ?? null,
    p_factory_id: args?.factoryId ?? null,
  });
  if (error) throw error;
  return (data as SaInvoiceRow[]) ?? [];
}

/** Pending total, counts and lifetime collected — the Billing section header. */
export async function saBillingSummary(): Promise<SaBillingSummary> {
  const { data, error } = await supabase.rpc('sa_billing_summary');
  if (error) throw error;
  // A set-returning function comes back as an array of one row.
  const row = (Array.isArray(data) ? data[0] : data) as SaBillingSummary | undefined;
  return (
    row ?? {
      pending_total: 0,
      pending_count: 0,
      overdue_count: 0,
      paid_total: 0,
      factory_count: 0,
    }
  );
}

/** Raise the next cycle's invoice against a factory. */
export async function saIssueInvoice(input: {
  factoryId: string;
  amount?: number | null;
  dueDate?: string | null;
  note?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc('sa_issue_invoice', {
    p_factory_id: input.factoryId,
    p_amount: input.amount ?? null,
    p_due_date: input.dueDate ?? null,
    p_note: input.note ?? null,
  });
  if (error) throw error;
}

/** Settle one pending invoice. Also re-derives the factory's Paid/Unpaid pill. */
export async function saMarkInvoicePaid(invoiceId: string): Promise<void> {
  const { error } = await supabase.rpc('sa_mark_invoice_paid', {
    p_invoice_id: invoiceId,
    p_paid_on: null,
  });
  if (error) throw error;
}

export type { Factory, Module, FactoryModule };
