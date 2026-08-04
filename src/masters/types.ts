/**
 * The entity-config contract that drives the generic master screens.
 *
 * MasterListScreen and MasterFormScreen read ONLY from these configs — adding a
 * fifth master entity later means adding a config object, not a screen.
 *
 * Field types are deliberately few. `select` and `linked` exist because
 * finishing partners need them now, and the same two patterns recur later for
 * job card lines (needle/colour selects) and PO items (linked supplier).
 */
import type { Role, ModuleKey } from '../constants/roles';

export type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'linked' | 'checkbox';

export interface SelectOption {
  value: string;
  label: string;
}

export interface FieldConfig {
  /** Column name on the table. */
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  /** Render in monospace — for codes, rates, and other reference/identifier values. */
  mono?: boolean;
  /** `select` only: the fixed option set. */
  options?: SelectOption[];
  /**
   * `linked` only: where to pull selectable records from.
   * Scoped by RLS to the caller's factory automatically.
   */
  linkedTo?: {
    table: string;
    labelColumn: string;
    /** Optional equality filters, e.g. { role: 'finishing_partner' }. */
    filter?: Record<string, string>;
    emptyLabel?: string;
  };
  /** number only */
  min?: number;
  max?: number;
  step?: number;
}

export interface MasterEntityConfig {
  /** Stable key used in navigation params. */
  key: string;
  table: string;
  /** "Vendor" / "Vendors" — used in titles, buttons, and confirm copy. */
  singular: string;
  plural: string;
  /** Column shown as the row's primary identifier. */
  titleField: string;
  /** Columns shown on the row's secondary line, in order. */
  subtitleFields?: string[];
  /** Column that free-text search runs against (ilike). */
  searchField: string;
  fields: FieldConfig[];
  /** Roles allowed to create/edit. Mirrors the RLS write policy. */
  writeRoles: Role[];
  /** Roles allowed to archive. Mirrors the RLS delete policy. */
  archiveRoles: Role[];
  /** Module this entity requires, if any (RLS enforces it too). */
  module?: ModuleKey;
}
