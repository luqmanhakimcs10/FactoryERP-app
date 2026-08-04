/**
 * The 13 user roles and the 4 toggleable modules.
 * Role keys MUST match the CHECK constraint on profiles.role in the DB migration.
 * Module keys MUST match modules.key in the DB.
 */

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  COMPANY_ADMIN: 'company_admin',
  ACCOUNTANT: 'accountant',
  FLOOR_MANAGER: 'floor_manager',
  STORE_MANAGER: 'store_manager',
  ORDER_TAKER: 'order_taker',
  QA: 'qa',
  PROCUREMENT: 'procurement',
  DELIVERY: 'delivery',
  WORKER: 'worker',
  FINISHING_PARTNER: 'finishing_partner',
  MANAGER: 'manager',
  LABOUR: 'labour',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: Role[] = Object.values(ROLES);

/** Human-readable badge label per role. */
export const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  company_admin: 'Company Admin',
  accountant: 'Accountant',
  floor_manager: 'Floor Manager',
  store_manager: 'Store Manager',
  order_taker: 'Order Taker',
  qa: 'Initial QA',
  procurement: 'Procurement',
  delivery: 'Delivery',
  worker: 'Worker',
  finishing_partner: 'Finishing Partner',
  manager: 'Manager',
  labour: 'Labour',
};

/** Landing screen title per role (from app-flow §0 role router). */
export const ROLE_HOME_TITLE: Record<Role, string> = {
  super_admin: 'Factory List',
  company_admin: 'Dashboard',
  accountant: 'Dashboard',
  floor_manager: "Today's Floor",
  store_manager: 'Stock Home',
  order_taker: 'Dashboard',
  qa: 'Inspection Queue',
  procurement: 'PO Queue',
  delivery: 'Orders',
  worker: 'My Dashboard',
  finishing_partner: 'My Dashboard',
  manager: 'Dashboard',
  labour: 'Dashboard',
};

// ---- Modules (toggleable per factory) ----

export const MODULES = {
  ORDER_LIFECYCLE: 'order_lifecycle',
  INVENTORY_PROCUREMENT: 'inventory_procurement',
  MACHINE_WORKFORCE: 'machine_workforce',
  FINANCE_REPORTS: 'finance_reports',
} as const;

export type ModuleKey = (typeof MODULES)[keyof typeof MODULES];

export const MODULE_LABEL: Record<ModuleKey, string> = {
  order_lifecycle: 'Order Lifecycle',
  inventory_procurement: 'Inventory & Procurement',
  machine_workforce: 'Machine & Workforce',
  finance_reports: 'Finance & Reports',
};
