/**
 * Ledgers Home — the accountant's landing screen.
 *
 * Four tabs: Payables (POs from Phase 4), Receivables (invoices from Final QA),
 * Salary (Phase 5's run, which now reads real damage deductions and loan
 * installments), and Loans.
 *
 * Recording a payable payment is what finally resolves the "awaiting accountant
 * payment" state Phase 4 left open.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { StatusPill } from '../../components/ui/StatusPill';
import { ListRow } from '../../components/lists/ListRow';
import { listPurchaseOrders } from '../../api/endpoints/inventory';
import { listInvoices, listLoans } from '../../api/endpoints/finance';
import { PO_STATUS_LABEL } from '../../models/inventoryTypes';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

type Tab = 'payables' | 'receivables' | 'salary' | 'loans';

const TABS: { key: Tab; label: string }[] = [
  { key: 'payables', label: 'Payables' },
  { key: 'receivables', label: 'Receivables' },
  { key: 'salary', label: 'Salary' },
  { key: 'loans', label: 'Loans' },
];

export function LedgersHomeScreen() {
  const navigation = useNavigation<any>();
  const [tab, setTab] = useState<Tab>('payables');

  // Payables: POs the owner has approved and that are waiting on payment.
  const payables = useQuery({
    queryKey: ['purchaseOrders', 'payable'],
    queryFn: () => listPurchaseOrders(['approved', 'awaiting_approval', 'paid', 'handed_over', 'received']),
    enabled: tab === 'payables',
  });

  const receivables = useQuery({
    queryKey: ['invoices'],
    queryFn: () => listInvoices(),
    enabled: tab === 'receivables',
  });

  const loans = useQuery({
    queryKey: ['loans'],
    queryFn: listLoans,
    enabled: tab === 'loans',
  });

  return (
    <Screen padded={false}>
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: tab === t.key, selected: tab === t.key }}
            {...(Platform.OS === 'web' ? ({ 'aria-checked': tab === t.key } as object) : {})}
            style={({ pressed }) => [styles.tab, tab === t.key && styles.tabOn, pressed && { opacity: 0.75 }]}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'payables' ? (
        <QueryList
          q={payables}
          emptyTitle="No payables"
          emptyBody="Approved purchase orders awaiting payment appear here."
          keyOf={(p: any) => p.id}
          render={(po: any) => (
            <Pressable
              onPress={() => navigation.navigate('PoDetail', { poId: po.id })}
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowTop}>
                <Text style={styles.code}>{po.po_code}</Text>
                <StatusPill
                  label={PO_STATUS_LABEL[po.status as keyof typeof PO_STATUS_LABEL] ?? po.status}
                  color={po.status === 'approved' ? colors.warning : colors.slate}
                />
              </View>
              <Text style={styles.sub}>{po.suppliers?.name ?? 'No supplier'}</Text>
              <Text style={styles.meta}>
                {po.amount ? <Text style={styles.mono}>{Number(po.amount).toLocaleString()}</Text> : 'No amount on bill'}
                {po.status === 'approved' ? ' · awaiting payment' : ''}
              </Text>
              {po.status === 'approved' ? (
                <Text style={styles.action}>Record payment →</Text>
              ) : null}
            </Pressable>
          )}
        />
      ) : null}

      {tab === 'receivables' ? (
        <QueryList
          q={receivables}
          emptyTitle="No invoices yet"
          emptyBody="Invoices appear here once the floor manager raises one at final QA."
          keyOf={(i: any) => i.id}
          render={(inv: any) => (
            <Pressable
              onPress={() => navigation.navigate('InvoiceDetail', { invoiceId: inv.id })}
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowTop}>
                <Text style={styles.code}>{inv.invoice_code}</Text>
                <StatusPill
                  label={inv.status === 'paid' ? 'Paid' : 'Pending'}
                  color={inv.status === 'paid' ? colors.success : colors.warning}
                />
              </View>
              <Text style={styles.sub}>
                {inv.orders?.vendors?.name ?? '—'}
                {inv.orders?.order_code ? ` · ${inv.orders.order_code}` : ''}
              </Text>
              <Text style={styles.meta}>
                <Text style={styles.mono}>{Number(inv.amount).toLocaleString()}</Text>
                {' · issued '}
                {new Date(inv.issued_at).toLocaleDateString()}
              </Text>
              {inv.status !== 'paid' ? <Text style={styles.action}>Record payment →</Text> : null}
            </Pressable>
          )}
        />
      ) : null}

      {tab === 'salary' ? (
        <View style={styles.panel}>
          <Text style={styles.panelText}>
            The salary run reads each worker's ledger for the period, now
            including damage deductions approved by the owner and installments on
            any active loan.
          </Text>
          <ListRow
            title="Open salary run"
            subtitle="Review, finalize and attach payment proofs"
            onPress={() => navigation.navigate('SalaryRun')}
          />
        </View>
      ) : null}

      {tab === 'loans' ? (
        <QueryList
          q={loans}
          emptyTitle="No loans recorded"
          emptyBody="Loans are approved outside the app; record an approved one here."
          header={
            <View style={styles.panel}>
              <Pressable
                onPress={() => navigation.navigate('AddLoan')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.75 }]}
              >
                <Text style={styles.addBtnText}>+ Record a loan</Text>
              </Pressable>
            </View>
          }
          keyOf={(l: any) => l.id}
          render={(l: any) => (
            <View style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.sub}>{l.profiles?.display_name ?? 'Worker'}</Text>
                <StatusPill
                  label={l.status === 'active' ? 'Active' : 'Paid off'}
                  color={l.status === 'active' ? colors.indigo : colors.success}
                />
              </View>
              <Text style={styles.meta}>
                Balance <Text style={styles.mono}>{Number(l.balance).toLocaleString()}</Text> of{' '}
                <Text style={styles.mono}>{Number(l.principal).toLocaleString()}</Text>
                {' · '}
                <Text style={styles.mono}>{Number(l.installment_amount).toLocaleString()}</Text>/period
              </Text>
              {l.starts_period ? (
                <Text style={styles.meta}>
                  Deductions start {l.starts_period} — never applied retroactively
                </Text>
              ) : null}
            </View>
          )}
        />
      ) : null}

      {/* Expenses are reachable from every tab: they are not one ledger's concern. */}
      <View style={styles.footer}>
        <Pressable
          onPress={() => navigation.navigate('Expenses')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.footerBtn, pressed && { opacity: 0.75 }]}
        >
          <Text style={styles.footerBtnText}>Fixed &amp; manual expenses</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

/** Small helper so each tab doesn't repeat the loading/error/empty scaffolding. */
function QueryList({
  q,
  emptyTitle,
  emptyBody,
  render,
  keyOf,
  header,
}: {
  q: any;
  emptyTitle: string;
  emptyBody: string;
  render: (item: any) => React.ReactElement;
  keyOf: (item: any) => string;
  header?: React.ReactElement;
}) {
  if (q.isLoading) {
    return <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />;
  }
  if (q.isError) {
    return <Text style={styles.emptyBody}>{describeDbError(q.error, 'Ledger')}</Text>;
  }
  return (
    <FlatList
      data={q.data ?? []}
      keyExtractor={keyOf}
      ListHeaderComponent={header}
      refreshControl={
        <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>{emptyTitle}</Text>
          <Text style={styles.emptyBody}>{emptyBody}</Text>
        </View>
      }
      renderItem={({ item }) => render(item)}
    />
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.lg },
  tab: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  tabText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    fontWeight: fontWeight.medium,
  },
  tabTextOn: { color: colors.white, fontWeight: fontWeight.semibold },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  sub: { fontSize: fontSize.secondary, color: colors.indigoDeep, flexShrink: 1 },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  action: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.brass, fontWeight: fontWeight.semibold },
  panel: { padding: spacing.lg, gap: spacing.md },
  panelText: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  addBtn: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.brass,
  },
  addBtnText: { color: colors.indigoDeep, fontSize: fontSize.body, fontWeight: fontWeight.semibold },
  footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border },
  footerBtn: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.indigo,
  },
  footerBtnText: { color: colors.indigo, fontSize: fontSize.secondary, fontWeight: fontWeight.medium },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { paddingHorizontal: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
