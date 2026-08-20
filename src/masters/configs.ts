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
    // `price` was a third rate with no rule saying when it applied; it is gone
    // from the card and dropped from the table (0086). The billing date is what
    // replaced it: the day this client is invoiced on.
    { key: 'billing_date', label: 'Billing date', type: 'date', placeholder: 'Not set' },
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
    {
      // Which stock this supplier is a source for. Same four values
      // `inventory_items.item_type` allows, so a PO raised against them can
      // only ever name a type they actually sell.
      key: 'inventory_types',
      label: 'Supplies which inventory types',
      type: 'multiselect',
      options: [
        { value: 'thread', label: 'Thread' },
        { value: 'tilla', label: 'Tilla' },
        { value: 'sequin', label: 'Sequin' },
        { value: 'bobbin', label: 'Bobbin' },
      ],
    },
  ],
};

export const MACHINES: MasterEntityConfig = {
  key: 'machines',
  table: 'machines',
  singular: 'Machine',
  plural: 'Machines',
  titleField: 'name',
  searchField: 'name',
  module: 'machine_workforce',
  writeRoles: [ROLES.COMPANY_ADMIN, ROLES.FLOOR_MANAGER],
  archiveRoles: [ROLES.COMPANY_ADMIN],
  // ONE FIELD. The machine-type selector is gone: a machine is identified on
  // the floor by its number, and the eleven categories behind that selector
  // never decided anything — no routing, no rate, no capability check read
  // them. `machines.machine_type` keeps its NOT NULL default in the database
  // so existing rows and the accountant's fleet screen are unaffected; it is
  // simply no longer asked for or shown here.
  fields: [
    {
      key: 'name',
      label: 'Machine number',
      type: 'text',
      required: true,
      placeholder: 'e.g. M-12',
      mono: true,
    },
  ],
};

/**
 * Finishing partners no longer hold an account.
 *
 * The `user_id` "Partner login" field and the "Extended partner" checkbox are
 * both gone. A partner is now reached by ONE persistent link generated when the
 * record is created (0086) — shown, copied and shared from this card once the
 * record exists, which is why the link is rendered by MasterFormScreen rather
 * than declared as a field here: there is nothing to type into it.
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
