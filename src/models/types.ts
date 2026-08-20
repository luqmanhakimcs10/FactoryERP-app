/**
 * TypeScript models mirroring the Phase 1 database tables.
 * Later phases extend this file (orders, repeats, shifts, ledgers, ...).
 */
import type { Role, ModuleKey } from '../constants/roles';

export type SubscriptionStatus = 'paid' | 'unpaid';
export type AccountStatus = 'active' | 'inactive';

export interface Factory {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  plan: string | null;
  created_at: string;
  /** Super-admin billing & contact (0028). */
  representative_name?: string | null;
  phone?: string | null;
  address?: string | null;
  subscription_amount?: number;
  subscription_status?: SubscriptionStatus;
  account_status?: AccountStatus;
  next_billing_date?: string | null;
  code_prefix?: string;
}

/** Row from sa_factory_list() — tenancy + billing aggregates only. */
export interface SaFactoryListRow {
  id: string;
  name: string;
  code_prefix: string;
  representative_name: string | null;
  phone: string | null;
  address: string | null;
  subscription_amount: number;
  subscription_status: SubscriptionStatus;
  account_status: AccountStatus;
  next_billing_date: string | null;
  active_modules: number;
  user_count: number;
  created_at: string;
}

/** Row from sa_factory_modules(). */
export interface SaFactoryModuleRow {
  module_id: string;
  key: ModuleKey;
  name: string;
  enabled: boolean;
}

/**
 * Platform billing (0085). One row per billing cycle per factory — the thing
 * the Super Admin's Billing section, Invoice History tab and a factory's
 * Payment History all render.
 */
export type FactoryInvoiceStatus = 'pending' | 'paid' | 'cancelled';

export interface SaInvoiceRow {
  id: string;
  factory_id: string;
  factory_name: string;
  invoice_code: string;
  amount: number;
  issued_on: string;
  due_date: string | null;
  status: FactoryInvoiceStatus;
  paid_on: string | null;
  note: string | null;
}

/** Row from sa_billing_summary(). */
export interface SaBillingSummary {
  pending_total: number;
  pending_count: number;
  overdue_count: number;
  paid_total: number;
  factory_count: number;
}

export interface Module {
  id: string;
  key: ModuleKey;
  name: string;
  is_core: boolean;
}

export interface FactoryModule {
  id: string;
  factory_id: string;
  module_id: string;
  enabled: boolean;
  enabled_at: string | null;
}

/** profiles extends Supabase auth.users — the app reads this to know who's logged in. */
export interface Profile {
  id: string; // == auth.users.id
  factory_id: string | null; // null only for super_admin (cross-tenant)
  role: Role;
  display_name: string;
  is_active: boolean;
  created_at: string;
  /** Per-stitch rate for piece-rate workers (Phase 5). */
  stitch_rate?: number | null;
}

// ---- Phase 2: master data ----

/** Columns every master table shares. */
interface MasterBase {
  id: string;
  factory_id: string;
  created_at: string;
  updated_at: string;
  /** Non-null = archived. Masters are soft-deleted so linked history survives. */
  deleted_at: string | null;
}

export interface Vendor extends MasterBase {
  name: string;
  contact: string | null;
  address: string | null;
  /** Pricing terms per client (0030). `price` was dropped in 0086. */
  rate_per_repeat?: number | null;
  rate_per_stitch?: number | null;
  /** The day this client is invoiced on — ISO date, picked on a calendar (0086). */
  billing_date?: string | null;
}

export interface Supplier extends MasterBase {
  name: string;
  contact: string | null;
  address?: string | null;
  /** Day of month payments are due (0030). */
  payment_day?: number | null;
  /** Which inventory types this supplier is a source for (0086). */
  inventory_types?: InventoryItemType[];
}

/** The four stock types `inventory_items.item_type` allows (0068). */
export type InventoryItemType = 'thread' | 'tilla' | 'sequin' | 'bobbin';

export const INVENTORY_TYPE_LABEL: Record<InventoryItemType, string> = {
  thread: 'Thread',
  tilla: 'Tilla',
  sequin: 'Sequin',
  bobbin: 'Bobbin',
};

export interface Machine extends MasterBase {
  name: string;
  machine_type?: MachineType | null;
}

export type MachineType =
  | 'sewing_machine'
  | 'overlock'
  | 'flatlock'
  | 'embroidery_machine'
  | 'cutter'
  | 'press_machine'
  | 'button_attaching'
  | 'piko'
  | 'karandi'
  | 'fusing'
  | 'other';

export type StageType = 'embroidery' | 'clipping' | 'press' | 'piko';
export type RateBasis = 'per_stitch' | 'per_repeat';

export interface FinishingPartner extends MasterBase {
  name: string;
  stage_type: StageType;
  rate_basis: RateBasis;
  rate: number;
  /**
   * Legacy login link. Partners are no longer given accounts (0086) — the
   * column survives so partners created before the change keep resolving.
   */
  user_id: string | null;
  /**
   * The partner's persistent, bookmarkable link (0086). Unguessable, tied to
   * this record, and revoked by archiving the partner.
   */
  access_token?: string | null;
  token_issued_at?: string | null;
}

// ---- Company admin: employee compensation (0030) ----

export type SalaryType = 'per_month' | 'per_day' | 'per_stitch';

export const SALARY_TYPE_LABEL: Record<SalaryType, string> = {
  per_month: 'Monthly',
  per_day: 'Daily',
  per_stitch: 'Per stitch',
};

/** Rows the owner's Employees screen shows — profile + compensation joined. */
export interface EmployeeRow {
  id: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  employee_compensation: EmployeeCompensation | null;
}

export interface EmployeeCompensation {
  id: string;
  factory_id: string;
  user_id: string;
  role: Role;
  salary_type: SalaryType;
  salary_amount: number;
  created_at: string;
  updated_at: string;
}
