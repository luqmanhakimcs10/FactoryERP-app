/**
 * Super Admin shared bits — formatters and the three status pills.
 *
 * These used to hang off the bottom of FactoryListScreen, which meant the
 * detail screen imported a list screen to render a currency string. The 3-tab
 * restructure has five screens sharing them, so they live on their own now.
 */
import React from 'react';
import { StatusPill } from '../../components/ui/StatusPill';
import { colors } from '../../constants/theme';
import type {
  AccountStatus,
  FactoryInvoiceStatus,
  SubscriptionStatus,
} from '../../models/types';

export function formatMoney(amount: number | null | undefined): string {
  return `Rs ${Number(amount ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** True for a pending invoice whose due date has passed. */
export function isOverdue(dueDate: string | null, status: FactoryInvoiceStatus): boolean {
  if (status !== 'pending' || !dueDate) return false;
  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

export function subscriptionPill(status: SubscriptionStatus) {
  return (
    <StatusPill
      label={status === 'paid' ? 'Paid' : 'Unpaid'}
      color={status === 'paid' ? colors.success : colors.warning}
    />
  );
}

export function accountPill(status: AccountStatus) {
  return (
    <StatusPill
      label={status === 'active' ? 'Active' : 'Inactive'}
      color={status === 'active' ? colors.success : colors.inkMuted}
    />
  );
}

/**
 * Overdue is not a stored status — it is a pending invoice past its due date.
 * Showing it as its own pill is the whole point of the Pending sub-tab, so the
 * derivation lives here rather than in each screen.
 */
export function invoiceStatusPill(status: FactoryInvoiceStatus, dueDate: string | null) {
  if (isOverdue(dueDate, status)) {
    return <StatusPill label="Overdue" color={colors.alert} />;
  }
  if (status === 'paid') return <StatusPill label="Paid" color={colors.success} />;
  if (status === 'cancelled') return <StatusPill label="Cancelled" color={colors.inkMuted} />;
  return <StatusPill label="Pending" color={colors.warning} />;
}
