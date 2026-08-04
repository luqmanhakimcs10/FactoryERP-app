/**
 * Box 6 — Invoices. Two sections: Receivable and Payable.
 *
 * Receivable is the same invoice data the Clients box shows, seen through the
 * accounting lens (what is owed to the factory, what has come in, what is
 * overdue) rather than per client. It is one dataset with two views, not two
 * datasets.
 *
 * Payable has five categories, each reading its own existing source:
 *   Finishing Partner -> partner_ledger (earnings − damages − payments)
 *   Supplier          -> purchase_orders not yet paid or received
 *   Bills             -> expenses(category=bills), grouped by the free-text subtype
 *   Maintenance       -> expenses(category=maintenance)
 *   Salary            -> a summary of worker_ledger that LINKS INTO Salary Run.
 *                        The run itself is not duplicated here: two places to
 *                        finalize payroll from is one place too many.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  Platform,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ListRow } from '../../components/lists/ListRow';
import {
  getReceivableSummary,
  listReceivableInvoices,
  listPayablePartners,
  listPayableSupplierPos,
  listPayableExpenses,
  listBillSubtypes,
  getSalaryOutstanding,
} from '../../api/endpoints/accounting';
import { PO_STATUS_LABEL } from '../../models/inventoryTypes';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';
import {
  money,
  count,
  shortDate,
  Tile,
  TileGrid,
  SectionTitle,
  FlatRow,
  EmptyNote,
  ProofThumb,
  invoicePill,
  expensePill,
  styles as shared,
} from './parts';

type Section = 'receivable' | 'payable';
type PayableCategory = 'partner' | 'supplier' | 'bills' | 'maintenance' | 'salary';

const PAYABLE_TABS: { key: PayableCategory; label: string }[] = [
  { key: 'partner', label: 'Finishing Partner' },
  { key: 'supplier', label: 'Supplier' },
  { key: 'bills', label: 'Bills' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'salary', label: 'Salary' },
];

function Chip({
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on, selected: on }}
      {...(Platform.OS === 'web' ? ({ 'aria-checked': on } as object) : {})}
      style={({ pressed }) => [local.chip, on && local.chipOn, pressed && { opacity: 0.75 }]}
    >
      <Text style={[local.chipText, on && local.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function AccountantInvoicesScreen() {
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();
  const financeOn = isModuleEnabled(MODULES.FINANCE_REPORTS, enabledModules, role);
  const payrollOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);

  const [section, setSection] = useState<Section>('receivable');
  const [category, setCategory] = useState<PayableCategory>('partner');

  const receivableSummary = useQuery({
    queryKey: ['acctReceivableSummary'],
    queryFn: getReceivableSummary,
    enabled: financeOn && section === 'receivable',
  });
  const receivableInvoices = useQuery({
    queryKey: ['acctReceivableInvoices'],
    queryFn: listReceivableInvoices,
    enabled: financeOn && section === 'receivable',
  });
  const partners = useQuery({
    queryKey: ['acctPayablePartners'],
    queryFn: listPayablePartners,
    enabled: financeOn && section === 'payable' && category === 'partner',
  });
  const supplierPos = useQuery({
    queryKey: ['acctPayableSuppliers'],
    queryFn: listPayableSupplierPos,
    enabled: financeOn && section === 'payable' && category === 'supplier',
  });
  const bills = useQuery({
    queryKey: ['acctPayableExpenses', 'bills'],
    queryFn: () => listPayableExpenses('bills'),
    enabled: financeOn && section === 'payable' && category === 'bills',
  });
  const billTypes = useQuery({
    queryKey: ['acctBillSubtypes'],
    queryFn: listBillSubtypes,
    enabled: financeOn && section === 'payable' && category === 'bills',
  });
  const maintenance = useQuery({
    queryKey: ['acctPayableExpenses', 'maintenance'],
    queryFn: () => listPayableExpenses('maintenance'),
    enabled: financeOn && section === 'payable' && category === 'maintenance',
  });
  const salary = useQuery({
    queryKey: ['acctSalaryOutstanding'],
    queryFn: () => getSalaryOutstanding(),
    enabled: payrollOn && section === 'payable' && category === 'salary',
  });

  if (!financeOn) {
    return (
      <Screen>
        <Text style={shared.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const tabs = (
    <View style={local.tabs}>
      <Chip label="Receivable" on={section === 'receivable'} onPress={() => setSection('receivable')} />
      <Chip label="Payable" on={section === 'payable'} onPress={() => setSection('payable')} />
    </View>
  );

  // ---- Receivable ----
  if (section === 'receivable') {
    const s = receivableSummary.data;
    const invoices = receivableInvoices.data ?? [];
    return (
      <Screen padded={false}>
        <FlatList
          data={invoices}
          keyExtractor={(i) => i.invoice_id}
          refreshControl={
            <RefreshControl
              refreshing={receivableInvoices.isRefetching}
              onRefresh={() => {
                receivableSummary.refetch();
                receivableInvoices.refetch();
              }}
              tintColor={colors.indigo}
            />
          }
          ListHeaderComponent={
            <View>
              {tabs}
              <SectionTitle>Receivable</SectionTitle>
              <TileGrid>
                <Tile label="Total income" value={money(s?.total_income)} />
                <Tile label="Received" value={money(s?.received)} tone={colors.success} />
                <Tile
                  label="Pending"
                  value={money(s?.pending)}
                  tone={Number(s?.pending ?? 0) > 0 ? colors.warning : undefined}
                />
                <Tile
                  label="Overdue"
                  value={money(s?.overdue_amount)}
                  tone={Number(s?.overdue_amount ?? 0) > 0 ? colors.alert : undefined}
                />
                <Tile label="Unpaid invoices" value={count(s?.unpaid_count)} />
                <Tile label="Next due" value={shortDate(s?.next_due_date)} mono={false} />
              </TileGrid>
              {receivableSummary.isLoading || receivableInvoices.isLoading ? (
                <ActivityIndicator color={colors.indigo} />
              ) : null}
              {receivableInvoices.isError ? (
                <Text style={shared.error}>
                  {describeDbError(receivableInvoices.error, 'Invoices')}
                </Text>
              ) : null}
              <SectionTitle>Invoices ({invoices.length})</SectionTitle>
              {!receivableInvoices.isLoading && invoices.length === 0 ? (
                <EmptyNote>
                  No invoices yet. They appear here once the floor manager raises one at final QA.
                </EmptyNote>
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <FlatRow
              code={item.invoice_code}
              pill={invoicePill(item.status, item.is_overdue)}
              onPress={() => navigation.navigate('InvoiceDetail', { invoiceId: item.invoice_id })}
              lines={[
                `${money(item.amount)} · ${item.vendor_name}`,
                `Issued ${shortDate(item.issued_at)} · due ${shortDate(item.due_date)}${
                  item.order_code ? ` · ${item.order_code}` : ''
                }`,
                item.status === 'paid' ? null : 'Tap to record payment',
              ]}
              right={<ProofThumb path={item.photo_url} label="Invoice photo" />}
            />
          )}
        />
      </Screen>
    );
  }

  // ---- Payable ----
  const header = (
    <View>
      {tabs}
      <View style={local.subTabs}>
        {PAYABLE_TABS.map((t) => (
          <Chip
            key={t.key}
            label={t.label}
            on={category === t.key}
            onPress={() => setCategory(t.key)}
          />
        ))}
      </View>
    </View>
  );

  if (category === 'partner') {
    const rows = partners.data ?? [];
    const totalPayable = rows.reduce((sum, r) => sum + Number(r.payable), 0);
    return (
      <Screen padded={false}>
        <FlatList
          data={rows}
          keyExtractor={(p) => p.partner_id}
          refreshControl={
            <RefreshControl
              refreshing={partners.isRefetching}
              onRefresh={partners.refetch}
              tintColor={colors.indigo}
            />
          }
          ListHeaderComponent={
            <View>
              {header}
              <SectionTitle>Finishing partners</SectionTitle>
              <TileGrid>
                <Tile label="Total payable" value={money(totalPayable)} wide />
              </TileGrid>
              {partners.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
              {partners.isError ? (
                <Text style={shared.error}>{describeDbError(partners.error, 'Partners')}</Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            !partners.isLoading ? <EmptyNote>No finishing partners on file.</EmptyNote> : null
          }
          ListFooterComponent={
            <ListRow
              title="Record a partner payment"
              subtitle="Writes the payment, the expense and the partner ledger together"
              onPress={() => navigation.navigate('Expenses')}
            />
          }
          renderItem={({ item }) => (
            <FlatRow
              code={item.name}
              mono={false}
              pill={{
                label: Number(item.payable) > 0 ? 'Owed' : 'Settled',
                color: Number(item.payable) > 0 ? colors.warning : colors.success,
              }}
              lines={[
                `Invoice value ${money(item.earnings)} · damages ${money(item.damages)}`,
                `Paid ${money(item.paid)} · payable ${money(item.payable)}`,
                item.stage_type.replace(/_/g, ' '),
              ]}
            />
          )}
        />
      </Screen>
    );
  }

  if (category === 'supplier') {
    const rows = supplierPos.data ?? [];
    const total = rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
    return (
      <Screen padded={false}>
        <FlatList
          data={rows}
          keyExtractor={(p) => p.po_id}
          refreshControl={
            <RefreshControl
              refreshing={supplierPos.isRefetching}
              onRefresh={supplierPos.refetch}
              tintColor={colors.indigo}
            />
          }
          ListHeaderComponent={
            <View>
              {header}
              <SectionTitle>Unpaid purchase orders</SectionTitle>
              <TileGrid>
                <Tile label="Open POs" value={count(rows.length)} />
                <Tile label="Billed so far" value={money(total)} />
              </TileGrid>
              {supplierPos.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
              {supplierPos.isError ? (
                <Text style={shared.error}>{describeDbError(supplierPos.error, 'Purchase orders')}</Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            !supplierPos.isLoading ? <EmptyNote>Every purchase order is settled.</EmptyNote> : null
          }
          renderItem={({ item }) => (
            <FlatRow
              code={item.po_code}
              pill={{
                label:
                  (PO_STATUS_LABEL as Record<string, string>)[item.status] ??
                  item.status.replace(/_/g, ' '),
                color: item.status === 'approved' ? colors.warning : colors.indigo,
              }}
              onPress={() => navigation.navigate('PoDetail', { poId: item.po_id })}
              lines={[
                `${item.amount == null ? 'No amount on bill' : money(item.amount)} · ${
                  item.supplier_name ?? 'No supplier'
                }`,
                `${Number(item.quantity_meters).toLocaleString()} m · raised ${shortDate(item.created_at)}`,
                item.status === 'approved' ? 'Approved — awaiting payment' : null,
              ]}
            />
          )}
        />
      </Screen>
    );
  }

  if (category === 'bills' || category === 'maintenance') {
    const isBills = category === 'bills';
    const q = isBills ? bills : maintenance;
    const rows = q.data ?? [];
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const pending = rows
      .filter((r) => r.status === 'pending')
      .reduce((sum, r) => sum + Number(r.amount), 0);

    return (
      <Screen padded={false}>
        <FlatList
          data={rows}
          keyExtractor={(e) => e.expense_id}
          refreshControl={
            <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
          }
          ListHeaderComponent={
            <View>
              {header}
              <SectionTitle>{isBills ? 'Bills' : 'Maintenance'}</SectionTitle>
              <TileGrid>
                <Tile label="Recorded" value={money(total)} />
                <Tile
                  label="Awaiting approval"
                  value={money(pending)}
                  tone={pending > 0 ? colors.warning : undefined}
                />
              </TileGrid>

              {isBills ? (
                <>
                  <SectionTitle>Bill types in use</SectionTitle>
                  {(billTypes.data ?? []).length === 0 ? (
                    <EmptyNote>
                      No bill types yet. Add a bill and name its type — that name becomes a type,
                      and it is suggested back next time.
                    </EmptyNote>
                  ) : (
                    (billTypes.data ?? []).map((t) => (
                      <FlatRow
                        key={t.bill_subtype}
                        code={t.bill_subtype}
                        mono={false}
                        lines={[
                          `${money(t.total_amount)} across ${t.use_count} entr${
                            t.use_count === 1 ? 'y' : 'ies'
                          } · last ${shortDate(t.last_used)}`,
                        ]}
                      />
                    ))
                  )}
                </>
              ) : null}

              <ListRow
                title={isBills ? 'Add a bill' : 'Add a maintenance expense'}
                subtitle={
                  isBills
                    ? 'Name the bill type — a new name creates a new type'
                    : 'Photo of the invoice or receipt is required'
                }
                onPress={() => navigation.navigate('AcctAddExpense', { category })}
              />

              <SectionTitle>Entries ({rows.length})</SectionTitle>
              {q.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
              {q.isError ? (
                <Text style={shared.error}>{describeDbError(q.error, 'Expenses')}</Text>
              ) : null}
              {!q.isLoading && rows.length === 0 ? (
                <EmptyNote>Nothing recorded in this category yet.</EmptyNote>
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <FlatRow
              code={item.bill_subtype ?? (isBills ? 'Unnamed bill' : 'Maintenance')}
              mono={false}
              pill={expensePill(item.status)}
              lines={[
                money(item.amount),
                `${shortDate(item.expense_date)}${item.recurring ? ' · recurring' : ''}`,
                item.description,
              ]}
              right={<ProofThumb path={item.proof_url} label="Bill photo" />}
            />
          )}
        />
      </Screen>
    );
  }

  // ---- Salary ----
  const s = salary.data;
  return (
    <Screen padded={false}>
      <FlatList
        data={[]}
        renderItem={null as any}
        refreshControl={
          <RefreshControl
            refreshing={salary.isRefetching}
            onRefresh={salary.refetch}
            tintColor={colors.indigo}
          />
        }
        ListHeaderComponent={
          <View>
            {header}
            {!payrollOn ? (
              <Text style={shared.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
            ) : (
              <>
                <SectionTitle>Salary — period {s?.period ?? '—'}</SectionTitle>
                <TileGrid>
                  <Tile
                    label="Pending (not yet run)"
                    value={money(s?.pending_net)}
                    tone={Number(s?.pending_net ?? 0) > 0 ? colors.warning : undefined}
                  />
                  <Tile
                    label="Finalized, unpaid"
                    value={money(s?.unpaid_finalized)}
                    tone={Number(s?.unpaid_finalized ?? 0) > 0 ? colors.alert : undefined}
                  />
                  <Tile label="Finalized total" value={money(s?.finalized_net)} />
                  <Tile label="Employees in period" value={count(s?.employee_count)} />
                  <Tile label="Next pay date" value={shortDate(s?.next_pay_date)} mono={false} wide />
                </TileGrid>
                {salary.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
                {salary.isError ? (
                  <Text style={shared.error}>{describeDbError(salary.error, 'Salary')}</Text>
                ) : null}
                <Text style={shared.empty}>
                  "Finalized, unpaid" is pay that has been calculated and closed but has no payment
                  proof attached yet. Attaching it happens in the employee's ledger.
                </Text>
                <ListRow
                  title="Open Salary Run"
                  subtitle="Review, finalize and attach payment proofs"
                  onPress={() => navigation.navigate('SalaryRun')}
                />
              </>
            )}
            <ListRow
              title="Loans, expenses & payment history"
              subtitle="The Phase 7 ledgers, unchanged"
              onPress={() => navigation.navigate('LedgersHome')}
            />
          </View>
        }
      />
    </Screen>
  );
}

const local = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  subTabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  chipText: { fontSize: fontSize.caption, color: colors.slate, fontWeight: fontWeight.medium },
  chipTextOn: { color: colors.white },
});
