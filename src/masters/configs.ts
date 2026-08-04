/**
 * One config object per master entity. These are the ONLY entity-specific code
 * in Phase 2 — the list and form screens are generic.
 *
 * writeRoles / archiveRoles must stay in sync with the RLS policies in
 * 0005_masters_schema.sql. The DB is the enforcement; these just stop the UI
 * offering an action that would be rejected.
 */
import { ROLES } from '../constants/roles';
import type { MasterEntityConfig } from './types';

export const VENDORS: MasterEntityConfig = {
  key: 'vendors',
  table: 'vendors',
  singular: 'Client',
  plural: 'Clients',
  titleField: 'name',
  subtitleFields: ['contact', 'address'],
  searchField: 'name',
  writeRoles: [ROLES.COMPANY_ADMIN, ROLES.ORDER_TAKER],
  archiveRoles: [ROLES.COMPANY_ADMIN],
  fields: [
    { key: 'name', label: 'Client name', type: 'text', required: true, placeholder: 'e.g. Karachi Textiles' },
    { key: 'contact', label: 'Contact', type: 'text', placeholder: 'Phone or email', mono: true },
    { key: 'address', label: 'Address', type: 'textarea', placeholder: 'Street, city' },
    { key: 'rate_per_repeat', label: 'Rate per repeat', type: 'number', mono: true, min: 0, step: 0.01, placeholder: '0.00' },
    { key: 'rate_per_stitch', label: 'Rate per stitch', type: 'number', mono: true, min: 0, step: 0.0001, placeholder: '0.0000' },
    { key: 'price', label: 'Price', type: 'number', mono: true, min: 0, step: 0.01, placeholder: '0.00' },
  ],
};

export const SUPPLIERS: MasterEntityConfig = {
  key: 'suppliers',
  table: 'suppliers',
  singular: 'Supplier',
  plural: 'Suppliers',
  titleField: 'name',
  subtitleFields: ['contact', 'address'],
  searchField: 'name',
  writeRoles: [ROLES.COMPANY_ADMIN, ROLES.PROCUREMENT, ROLES.ACCOUNTANT],
  archiveRoles: [ROLES.COMPANY_ADMIN],
  fields: [
    { key: 'name', label: 'Supplier name', type: 'text', required: true, placeholder: 'e.g. Madeira Threads' },
    { key: 'contact', label: 'Contact', type: 'text', placeholder: 'Phone or email', mono: true },
    { key: 'address', label: 'Address', type: 'textarea', placeholder: 'Street, city' },
    { key: 'payment_day', label: 'Payment day', type: 'number', mono: true, min: 1, max: 31, placeholder: 'e.g. 5' },
  ],
};

export const MACHINES: MasterEntityConfig = {
  key: 'machines',
  table: 'machines',
  singular: 'Machine',
  plural: 'Machines',
  titleField: 'name',
  subtitleFields: ['machine_type'],
  searchField: 'name',
  module: 'machine_workforce',
  writeRoles: [ROLES.COMPANY_ADMIN, ROLES.FLOOR_MANAGER],
  archiveRoles: [ROLES.COMPANY_ADMIN],
  fields: [
    { key: 'name', label: 'Machine name / number', type: 'text', required: true, placeholder: 'e.g. M-12', mono: true },
    {
      key: 'machine_type',
      label: 'Machine type',
      type: 'select',
      required: true,
      options: [
        { value: 'sewing_machine', label: 'Sewing machine' },
        { value: 'overlock', label: 'Overlock' },
        { value: 'flatlock', label: 'Flatlock' },
        { value: 'embroidery_machine', label: 'Embroidery' },
        { value: 'cutter', label: 'Cutter' },
        { value: 'press_machine', label: 'Press' },
        { value: 'button_attaching', label: 'Button attaching' },
        { value: 'piko', label: 'Piko' },
        { value: 'karandi', label: 'Karandi' },
        { value: 'fusing', label: 'Fusing' },
        { value: 'other', label: 'Other' },
      ],
    },
  ],
};

/**
 * The one entity with non-trivial fields: a `select` (stage_type, rate_basis),
 * a `number` (rate), and a `linked` record (the partner's own login).
 */
export const FINISHING_PARTNERS: MasterEntityConfig = {
  key: 'finishing_partners',
  table: 'finishing_partners',
  singular: 'Finishing Partner',
  plural: 'Finishing Partners',
  titleField: 'name',
  subtitleFields: ['stage_type', 'rate_basis'],
  searchField: 'name',
  module: 'order_lifecycle',
  writeRoles: [ROLES.COMPANY_ADMIN, ROLES.ACCOUNTANT],
  archiveRoles: [ROLES.COMPANY_ADMIN],
  fields: [
    { key: 'name', label: 'Partner name', type: 'text', required: true, placeholder: 'e.g. Ali Clipping Works' },
    {
      key: 'stage_type',
      label: 'Stage handled',
      type: 'select',
      required: true,
      options: [
        { value: 'embroidery', label: 'Embroidery' },
        { value: 'clipping', label: 'Clipping' },
        { value: 'press', label: 'Press' },
        { value: 'piko', label: 'Piko' },
      ],
    },
    {
      key: 'rate_basis',
      label: 'Rate basis',
      type: 'select',
      required: true,
      options: [
        { value: 'per_stitch', label: 'Per stitch' },
        { value: 'per_repeat', label: 'Per repeat' },
      ],
    },
    {
      key: 'rate',
      label: 'Rate',
      type: 'number',
      required: true,
      mono: true,
      min: 0,
      step: 0.0001,
      placeholder: '0.0000',
    },
    {
      key: 'user_id',
      label: 'Partner login (for their dashboard)',
      type: 'linked',
      linkedTo: {
        table: 'profiles',
        labelColumn: 'display_name',
        filter: { role: 'finishing_partner' },
        emptyLabel: 'No login linked',
      },
    },
    {
      key: 'is_extended_partner',
      label: 'Extended partner (handles additional stages)',
      type: 'checkbox',
    },
  ],
};

export const MASTER_CONFIGS = {
  vendors: VENDORS,
  suppliers: SUPPLIERS,
  machines: MACHINES,
  finishing_partners: FINISHING_PARTNERS,
} as const;

export type MasterKey = keyof typeof MASTER_CONFIGS;

export function getMasterConfig(key: string): MasterEntityConfig {
  const cfg = MASTER_CONFIGS[key as MasterKey];
  if (!cfg) throw new Error(`Unknown master entity: ${key}`);
  return cfg;
}
