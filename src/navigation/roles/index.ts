/**
 * The 13 role navigators, one per role. Built from the shared factory so Phase 1
 * stays DRY; each can be replaced with a bespoke navigator as its screens land.
 */
import { createRoleNavigator } from './createRoleNavigator';
import { ROLES, type Role } from '../../constants/roles';
import type React from 'react';

export const ROLE_NAVIGATORS: Record<Role, React.ComponentType> = {
  [ROLES.SUPER_ADMIN]: createRoleNavigator(ROLES.SUPER_ADMIN),
  [ROLES.COMPANY_ADMIN]: createRoleNavigator(ROLES.COMPANY_ADMIN),
  [ROLES.ACCOUNTANT]: createRoleNavigator(ROLES.ACCOUNTANT),
  [ROLES.FLOOR_MANAGER]: createRoleNavigator(ROLES.FLOOR_MANAGER),
  [ROLES.STORE_MANAGER]: createRoleNavigator(ROLES.STORE_MANAGER),
  [ROLES.ORDER_TAKER]: createRoleNavigator(ROLES.ORDER_TAKER),
  [ROLES.QA]: createRoleNavigator(ROLES.QA),
  [ROLES.PROCUREMENT]: createRoleNavigator(ROLES.PROCUREMENT),
  [ROLES.DELIVERY]: createRoleNavigator(ROLES.DELIVERY),
  [ROLES.WORKER]: createRoleNavigator(ROLES.WORKER),
  [ROLES.FINISHING_PARTNER]: createRoleNavigator(ROLES.FINISHING_PARTNER),
  [ROLES.MANAGER]: createRoleNavigator(ROLES.MANAGER),
  [ROLES.LABOUR]: createRoleNavigator(ROLES.LABOUR),
};
