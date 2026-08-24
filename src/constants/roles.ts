/**
 * The user roles and the 4 toggleable modules.
 * Role keys MUST match `roles.key` in the DB (profiles.role is an FK to it).
 * Module keys MUST match modules.key in the DB.
 *
 * ORDER_DELIVERY is the merged Order Taker + Delivery Person (0086). It is a
 * real role on the profile, not a UI grouping: `has_any_role` expands it to
 * satisfy every existing `order_taker` and `delivery` check in the database, so
 * one account genuinely does both jobs.
 *
 * ORDER_TAKER and DELIVERY are kept because accounts created before the merge
 * still hold them — the employee picker no longer offers either.
 */

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  COMPANY_ADMIN: 'company_admin',
  ACCOUNTANT: 'accountant',
  FLOOR_MANAGER: 'floor_manager',
  STORE_MANAGER: 'store_manager',
  ORDER_TAKER: 'order_taker',
  ORDER_DELIVERY: 'order_delivery',
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
  order_delivery: 'Order/Delivery Person',
  /*
   * "Inspector", not "QA".
   *
   * The KEY stays `qa` — it is a foreign key from `profiles.role`, it appears
   * in every role gate in the database, and renaming it would be a data
   * migration to change a word on a badge. `roles.name` in the database was
   * changed to match (0092), so a screen reading the role name from either
   * side agrees.
   *
   * The INSPECTIONS keep their names: Stage QA, Pass QA, Final QA. Those are
   * steps, not people, and only the role was renamed.
   */
  qa: 'Inspector',
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
  order_delivery: 'Dashboard',
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
