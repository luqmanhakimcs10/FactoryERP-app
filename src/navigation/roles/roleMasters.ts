/**
 * Which master entities each role can reach.
 *
 * Read access is broader than write access: a role listed here gets the screen
 * in its navigator, but whether the "+ New" and "Save" actions appear is decided
 * by the entity config's writeRoles (and ultimately by RLS).
 *
 * Mapping per the phase brief: Order Taker + Owner need Vendors; Procurement +
 * Accountant need Suppliers; Floor Manager needs Machines; Owner + Accountant
 * need Finishing Partners. Owner also gets machines since they own the factory's
 * setup, and super_admin gets read access across everything for support.
 */
import { ROLES, type Role } from '../../constants/roles';
import type { MasterKey } from '../../masters/configs';

export const ROLE_MASTERS: Record<Role, MasterKey[]> = {
  [ROLES.SUPER_ADMIN]: [],
  [ROLES.COMPANY_ADMIN]: ['vendors', 'suppliers', 'machines', 'finishing_partners'],
  [ROLES.ACCOUNTANT]: ['suppliers', 'finishing_partners'],
  [ROLES.FLOOR_MANAGER]: ['machines', 'vendors'],
  [ROLES.STORE_MANAGER]: ['suppliers'],
  [ROLES.ORDER_TAKER]: ['vendors'],
  [ROLES.QA]: [],
  [ROLES.PROCUREMENT]: ['suppliers'],
  [ROLES.DELIVERY]: ['finishing_partners'],
  [ROLES.WORKER]: [],
  [ROLES.FINISHING_PARTNER]: [],
  [ROLES.MANAGER]: [],
  [ROLES.LABOUR]: [],
};

export function mastersForRole(role: Role | null | undefined): MasterKey[] {
  if (!role) return [];
  return ROLE_MASTERS[role] ?? [];
}
