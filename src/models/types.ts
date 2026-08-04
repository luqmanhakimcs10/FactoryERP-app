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

/** Row from sa_factory_inventory(). */
export interface SaFactoryInventoryRow {
  id: string;
  color_code: string;
  color_name: string | null;
  photo_url: string | null;
  quantity_meters: number;
  last_audit_at: string | null;
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
  /** Pricing terms per client (0030). */
  rate_per_repeat?: number | null;
  rate_per_stitch?: number | null;
  price?: number | null;
}

export interface Supplier extends MasterBase {
  name: string;
  contact: string | null;
  address?: string | null;
  /** Day of month payments are due (0030). */
  payment_day?: number | null;
}

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
  /** The partner's own login, for their read-only dashboard. */
  user_id: string | null;
  /** Extended partners handle stages beyond their primary type (0030). */
  is_extended_partner?: boolean;
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
