/**
 * Client-side permission convenience layer.
 *
 * IMPORTANT: This does NOT enforce security. Supabase Row Level Security is the
 * real enforcement (tenant isolation + module gating). This helper only decides
 * whether to render/route a screen, so the UI fails fast and cleanly instead of
 * firing a request the DB will reject.
 *
 * Phase 7 note: until now this checked BASE ROLE ONLY. The owner's Extra
 * Permissions screen grants per-user add-ons on top of a role, so every check
 * that a granted key could widen now takes the caller's granted keys too.
 * Add-ons only ever ADD capability — they can never remove what the base role
 * already allows, and granting a key does not widen any RLS policy by itself.
 */
import type { Role, ModuleKey } from '../constants/roles';

/**
 * Grantable add-on keys. Keeping these enumerated (rather than free text) means
 * the Extra Permissions screen can list them and a typo can't create a key that
 * silently never matches.
 */
export const PERMISSION_KEYS = {
  APPROVE_EXPENSES: 'approve_expenses',
  APPROVE_DAMAGE: 'approve_damage',
  VIEW_REPORTS: 'view_reports',
  VIEW_PROFITABILITY: 'view_profitability',
  RECORD_PAYMENTS: 'record_payments',
  MANAGE_MASTERS: 'manage_masters',
  CLOSE_SHIFTS: 'close_shifts',
  RUN_SALARY: 'run_salary',
} as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[keyof typeof PERMISSION_KEYS];

export const PERMISSION_LABEL: Record<PermissionKey, string> = {
  approve_expenses: 'Approve expenses',
  approve_damage: 'Approve damage deductions',
  view_reports: 'View reports',
  view_profitability: 'View per-order profitability',
  record_payments: 'Record payments',
  manage_masters: 'Manage master data',
  close_shifts: 'Close shifts',
  run_salary: 'Run salary',
};

export const ALL_PERMISSION_KEYS: PermissionKey[] = Object.values(PERMISSION_KEYS);

export function isSuperAdmin(role: Role | null | undefined): boolean {
  return role === 'super_admin';
}

/** May this role open a screen restricted to `allowed` roles? */
export function canAccessRole(role: Role | null | undefined, allowed: Role[]): boolean {
  if (!role) return false;
  if (role === 'super_admin') return true; // super admin transcends role gating
  return allowed.includes(role);
}

/** Has this user been granted a specific add-on? */
export function hasPermission(
  granted: string[] | null | undefined,
  key: PermissionKey
): boolean {
  return !!granted?.includes(key);
}

/**
 * The check most screens should use: allowed by base role, OR by a granted
 * add-on. Pass the add-on key a screen can also be unlocked by.
 */
export function canAccess(
  role: Role | null | undefined,
  allowed: Role[],
  granted?: string[] | null,
  unlockedBy?: PermissionKey
): boolean {
  if (canAccessRole(role, allowed)) return true;
  if (unlockedBy && hasPermission(granted, unlockedBy)) return true;
  return false;
}

/** Is a module available for the current factory? (super admin bypasses.) */
export function isModuleEnabled(
  moduleKey: ModuleKey,
  enabledModules: ModuleKey[],
  role?: Role | null
): boolean {
  if (role === 'super_admin') return true;
  return enabledModules.includes(moduleKey);
}
