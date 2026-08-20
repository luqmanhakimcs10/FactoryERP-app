/**
 * Super Admin home — three top-level tabs and nothing else.
 *
 *   Dashboard        Factories + Billing (Pending sub-tab, outstanding total)
 *   Modules          the per-factory module switches, promoted out of the
 *                    factory detail screen into a tab of its own
 *   Invoice History  every invoice, every factory
 *
 * WHAT IS DELIBERATELY ABSENT: inventory. Super Admin had a read-only view of
 * a factory's colour stock (name / code / photo / quantity / last audit). That
 * exception is withdrawn — there is no inventory reader left in the API layer
 * and 0085 dropped the RPCs and policies behind it, so this is not a hidden
 * screen, it is a removed capability.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  Switch,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { SelectField } from '../../components/forms/SelectField';
import { RowMenu } from '../../components/ui/RowMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { StatusPill } from '../../components/ui/StatusPill';
import { MetricCard, MetricRow, MetricsSection } from '../../components/ui/MetricCard';
import { statCount, statMoney } from '../../utils/statValue';
import { cumulativeTrend, periodTrend } from '../../utils/metricTrend';
import {
  saFactoryList,
  saFactoryModules,
  saToggleModule,
  saSetAccountStatus,
  saBillingSummary,
  saInvoiceList,
  saMarkInvoicePaid,
} from '../../api/endpoints/factories';
import { describeDbError } from '../../utils/errors';
import { MODULE_LABEL, type ModuleKey } from '../../constants/roles';
import {
  formatMoney,
  formatDate,
  isOverdue,
  subscriptionPill,
  accountPill,
  invoiceStatusPill,
} from './parts';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';
import type { SaFactoryListRow, SaInvoiceRow } from '../../models/types';

type TopTab = 'dashboard' | 'modules' | 'invoices';

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'modules', label: 'Modules' },
  { key: 'invoices', label: 'Invoice History' },
];

export function SuperAdminHomeScreen() {
  const navigation = useNavigation<any>();
  const [tab, setTab] = useState<TopTab>('dashboard');

  return (
    <Screen padded={false}>
      <DashboardHeader navigation={navigation} />
      <SegmentedTabs tabs={TOP_TABS} value={tab} onChange={setTab} />
      {tab === 'dashboard' ? <DashboardTab /> : null}
      {tab === 'modules' ? <ModulesTab /> : null}
      {tab === 'invoices' ? <InvoiceHistoryTab /> : null}
    </Screen>
  );
}

// ===========================================================================
// Dashboard tab — Factories, then Billing
// ===========================================================================

function DashboardTab() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();

  const factories = useQuery({ queryKey: ['saFactoryList'], queryFn: saFactoryList });
  const summary = useQuery({ queryKey: ['saBillingSummary'], queryFn: saBillingSummary });
  const pending = useQuery({
    queryKey: ['saInvoices', 'pending'],
    queryFn: () => saInvoiceList({ status: 'pending' }),
  });
  /**
   * Every invoice ever raised, for the billed-per-month line and the figure
   * above it. One read the Invoice History tab already makes — React Query
   * hands both tabs the same cached result.
   */
  const billed = useQuery({
    queryKey: ['saInvoices', 'all'],
    queryFn: () => saInvoiceList(),
  });

  const factoryTrend = cumulativeTrend(factories.data, (f) => f.created_at);
  const billedTrend = periodTrend(
    billed.data?.filter((i) => i.status !== 'cancelled'),
    (i) => i.issued_on,
    6,
    (i) => Number(i.amount ?? 0)
  );
  const billedThisMonth = billedTrend.trend
    ? billedTrend.trend[billedTrend.trend.length - 1]
    : undefined;

  // The factory the confirmation popup is currently about. Holding the whole
  // row (not just an id) keeps the copy specific — "Deactivate Alpha Textiles?"
  // rather than a generic warning the admin has to map back to a row.
  const [pendingToggle, setPendingToggle] = useState<SaFactoryListRow | null>(null);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unpaid = (factories.data ?? []).filter((f) => f.subscription_status === 'unpaid').length;
  const refreshing =
    factories.isRefetching || summary.isRefetching || pending.isRefetching;

  function refetchAll() {
    factories.refetch();
    summary.refetch();
    pending.refetch();
  }

  async function applyToggle() {
    if (!pendingToggle) return;
    const nextActive = pendingToggle.account_status !== 'active';
    setToggling(true);
    setError(null);
    try {
      await saSetAccountStatus(pendingToggle.id, nextActive);
      await queryClient.invalidateQueries({ queryKey: ['saFactoryList'] });
      setPendingToggle(null);
    } catch (e: any) {
      setError(describeDbError(e, 'Factory'));
    } finally {
      setToggling(false);
    }
  }

  const nextActive = pendingToggle ? pendingToggle.account_status !== 'active' : false;

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refetchAll} tintColor={colors.primary} />
        }
      >
        {/* Unpaid subscriptions are the only thing on this tab that needs the
            platform admin to DO something. Read from the list already loaded. */}
        {unpaid > 0 ? (
          <ActionBanner
            title={`${unpaid} factor${unpaid === 1 ? 'y has' : 'ies have'} an unpaid subscription`}
            subtitle="Settle or chase them from the Billing section below"
            style={styles.banner}
          />
        ) : null}

        {/* Both reads are already on this tab — the factory list for the
            tenancy figures, the billing summary for what is owed — so the block
            costs nothing extra.

            Only two of the four can carry a trend. "Total factories" is a
            cumulative count, so its line is that same count at each past month
            end. Billed-per-month likewise. The other two are live states:
            nothing recorded how many factories were unpaid in April. */}
        <MetricsSection subtitle="The platform, across every factory">
          <MetricRow>
            <MetricCard
              label="Total factories"
              value={statCount(factories.data?.length)}
              icon="business-outline"
              accent="teal"
              {...factoryTrend}
            />
            <MetricCard
              label="Active factories"
              value={statCount(
                factories.data?.filter((f) => f.account_status === 'active').length
              )}
              icon="checkmark-circle-outline"
              accent="green"
            />
            <MetricCard
              label="Unpaid subscriptions"
              value={statCount(factories.data ? unpaid : undefined)}
              icon="alert-circle-outline"
              accent={unpaid > 0 ? 'rose' : 'teal'}
            />
            <MetricCard
              label="Billed this month"
              value={billed.isError ? '—' : statMoney(billedThisMonth)}
              icon="cash-outline"
              accent="amber"
              emphasis
              {...billedTrend}
            />
          </MetricRow>
        </MetricsSection>

        {/* ---- Factories ---- */}
        <SectionHeading
          title="Factories"
          action={
            <AppButton
              title="Add factory"
              variant="brass"
              size="sm"
              onPress={() => navigation.navigate('NewFactory')}
            />
          }
        />

        {factories.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {factories.isError ? (
          <Text style={styles.error}>{describeDbError(factories.error, 'Factory list')}</Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!factories.isLoading && (factories.data ?? []).length === 0 ? (
          <EmptyBlock title="No factories yet" body="Create the first factory to get started." />
        ) : null}

        {(factories.data ?? []).map((f) => (
          <FactoryRow
            key={f.id}
            factory={f}
            onViewDetails={() => navigation.navigate('FactoryDetail', { factoryId: f.id })}
            onToggleAccount={() => setPendingToggle(f)}
            onPaymentHistory={() =>
              navigation.navigate('FactoryPaymentHistory', {
                factoryId: f.id,
                factoryName: f.name,
              })
            }
            onEdit={() => navigation.navigate('EditFactory', { factoryId: f.id })}
          />
        ))}

        {/* ---- Billing ---- */}
        <SectionHeading title="Billing" />
        <BillingPanel
          summary={summary.data}
          loading={summary.isLoading}
          summaryError={summary.error}
          rows={pending.data ?? []}
          rowsLoading={pending.isLoading}
          rowsError={pending.error}
          onSettled={() => {
            queryClient.invalidateQueries({ queryKey: ['saInvoices'] });
            queryClient.invalidateQueries({ queryKey: ['saBillingSummary'] });
            queryClient.invalidateQueries({ queryKey: ['saFactoryList'] });
          }}
        />
      </ScrollView>

      <ConfirmDialog
        visible={!!pendingToggle}
        title={nextActive ? 'Set this factory active?' : 'Set this factory inactive?'}
        message={
          pendingToggle
            ? nextActive
              ? `${pendingToggle.name}'s users will be able to sign in again.`
              : `All ${pendingToggle.user_count} user${
                  pendingToggle.user_count === 1 ? '' : 's'
                } of ${pendingToggle.name} will be blocked from signing in until it is set active again.`
            : ''
        }
        confirmLabel={nextActive ? 'Set active' : 'Set inactive'}
        destructive={!nextActive}
        loading={toggling}
        onConfirm={applyToggle}
        onCancel={() => {
          setPendingToggle(null);
          setError(null);
        }}
      />
    </>
  );
}

/**
 * One factory. The row itself is NOT pressable any more — the ⋮ menu carries
 * all four actions, so there is no hidden "primary" one that a tap would pick.
 */
function FactoryRow({
  factory,
  onViewDetails,
  onToggleAccount,
  onPaymentHistory,
  onEdit,
}: {
  factory: SaFactoryListRow;
  onViewDetails: () => void;
  onToggleAccount: () => void;
  onPaymentHistory: () => void;
  onEdit: () => void;
}) {
  const isActive = factory.account_status === 'active';

  return (
    <View style={styles.factoryRow}>
      <View style={styles.factoryBody}>
        <Text style={styles.factoryName} numberOfLines={1}>
          {factory.name}
        </Text>
        <Text style={styles.factorySub} numberOfLines={1}>
          {factory.active_modules} modules · {factory.user_count} users
        </Text>
        <Text style={styles.factoryCaption} numberOfLines={1}>
          {factory.next_billing_date
            ? `Next billing ${formatDate(factory.next_billing_date)} · ${formatMoney(
                factory.subscription_amount
              )}`
            : `${formatMoney(factory.subscription_amount)} / cycle`}
        </Text>
      </View>

      <View style={styles.pills}>
        {subscriptionPill(factory.subscription_status)}
        {accountPill(factory.account_status)}
      </View>

      <RowMenu
        title={factory.name}
        accessibilityLabel={`Actions for ${factory.name}`}
        options={[
          {
            key: 'view',
            label: 'View details',
            icon: 'information-circle-outline',
            onPress: onViewDetails,
          },
          {
            key: 'status',
            label: isActive ? 'Set inactive' : 'Set active',
            icon: isActive ? 'lock-closed-outline' : 'lock-open-outline',
            destructive: isActive,
            onPress: onToggleAccount,
          },
          {
            key: 'payments',
            label: 'Payment history',
            icon: 'receipt-outline',
            onPress: onPaymentHistory,
          },
          { key: 'edit', label: 'Edit', icon: 'create-outline', onPress: onEdit },
        ]}
      />
    </View>
  );
}

/**
 * Billing. One sub-tab exists (Pending) and it is selected — the brief asks for
 * the outstanding figure to be the visible one, and a lone tab that cannot be
 * deselected is still the honest way to label what the list underneath is.
 */
function BillingPanel({
  summary,
  loading,
  summaryError,
  rows,
  rowsLoading,
  rowsError,
  onSettled,
}: {
  summary?: {
    pending_total: number;
    pending_count: number;
    overdue_count: number;
    paid_total: number;
  };
  loading: boolean;
  summaryError: unknown;
  rows: SaInvoiceRow[];
  rowsLoading: boolean;
  rowsError: unknown;
  onSettled: () => void;
}) {
  const [settling, setSettling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function settle(invoiceId: string) {
    setSettling(invoiceId);
    setError(null);
    try {
      await saMarkInvoicePaid(invoiceId);
      onSettled();
    } catch (e: any) {
      setError(describeDbError(e, 'Invoice'));
    } finally {
      setSettling(null);
    }
  }

  return (
    <View style={styles.billingCard}>
      <Text style={styles.billingLabel}>Total pending across all factories</Text>
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start' }} />
      ) : summaryError ? (
        // Never print "Rs 0" for a figure that failed to load — a zero here
        // reads as "nothing is owed", which is the opposite of "unknown".
        <Text style={styles.billingUnknown}>—</Text>
      ) : (
        <Text style={styles.billingAmount}>{formatMoney(summary?.pending_total)}</Text>
      )}
      {summaryError ? (
        <Text style={styles.error}>{describeDbError(summaryError, 'Billing summary')}</Text>
      ) : (
        <Text style={styles.billingMeta}>
          {summary?.pending_count ?? 0} unpaid invoice
          {(summary?.pending_count ?? 0) === 1 ? '' : 's'}
          {summary?.overdue_count ? ` · ${summary.overdue_count} overdue` : ''} ·{' '}
          {formatMoney(summary?.paid_total)} collected to date
        </Text>
      )}

      <View style={styles.subTabs}>
        <View style={styles.subTabActive}>
          <Text style={styles.subTabActiveText}>
            Pending{rows.length ? ` (${rows.length})` : ''}
          </Text>
        </View>
      </View>

      {rowsLoading ? <ActivityIndicator color={colors.primary} /> : null}
      {rowsError ? (
        <Text style={styles.error}>{describeDbError(rowsError, 'Pending invoices')}</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* Only claim "all settled" when the list actually loaded. */}
      {!rowsLoading && !rowsError && rows.length === 0 ? (
        <Text style={styles.empty}>Nothing outstanding. Every factory is settled.</Text>
      ) : null}

      {rows.map((inv) => (
        <View key={inv.id} style={styles.invoiceRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.invoiceFactory} numberOfLines={1}>
              {inv.factory_name}
            </Text>
            <Text style={styles.invoiceMeta} numberOfLines={1}>
              {inv.invoice_code} · issued {formatDate(inv.issued_on)}
              {inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}
            </Text>
          </View>
          <View style={styles.invoiceRight}>
            <Text style={styles.invoiceAmount}>{formatMoney(inv.amount)}</Text>
            {isOverdue(inv.due_date, inv.status) ? (
              <StatusPill label="Overdue" color={colors.alert} />
            ) : null}
            <AppButton
              title="Mark paid"
              variant="secondary"
              size="sm"
              loading={settling === inv.id}
              disabled={!!settling}
              onPress={() => settle(inv.id)}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

// ===========================================================================
// Modules tab
// ===========================================================================

/**
 * Modules are per-factory, so a top-level Modules tab needs to say WHICH
 * factory before it can show a switch. The picker defaults to the first factory
 * rather than showing an empty state, so the tab is never a dead end.
 */
function ModulesTab() {
  const queryClient = useQueryClient();
  const [factoryId, setFactoryId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<ModuleKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const factories = useQuery({ queryKey: ['saFactoryList'], queryFn: saFactoryList });

  const options = useMemo(
    () => (factories.data ?? []).map((f) => ({ value: f.id, label: f.name })),
    [factories.data]
  );
  const selected = factoryId ?? options[0]?.value ?? null;

  const modules = useQuery({
    queryKey: ['saFactoryModules', selected],
    queryFn: () => saFactoryModules(selected as string),
    enabled: !!selected,
  });

  async function onToggle(key: ModuleKey, next: boolean) {
    if (!selected) return;
    setToggling(key);
    setError(null);
    try {
      await saToggleModule(selected, key, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['saFactoryModules', selected] }),
        queryClient.invalidateQueries({ queryKey: ['saFactoryList'] }),
      ]);
    } catch (e: any) {
      setError(describeDbError(e, 'Module'));
    } finally {
      setToggling(null);
    }
  }

  if (factories.isLoading) {
    return <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />;
  }

  if (options.length === 0) {
    return (
      <View style={styles.scroll}>
        <EmptyBlock
          title="No factories yet"
          body="Modules are enabled per factory — create one on the Dashboard tab first."
        />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Text style={styles.lede}>
        Enable or disable modules for a factory. Changes take effect immediately for all of its
        users.
      </Text>

      <SelectField
        label="Factory"
        value={selected}
        options={options}
        onChange={setFactoryId}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {modules.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
      {modules.isError ? (
        <Text style={styles.error}>{describeDbError(modules.error, 'Modules')}</Text>
      ) : null}

      {(modules.data ?? []).map((mod) => (
        <View key={mod.module_id} style={styles.moduleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.moduleName}>{MODULE_LABEL[mod.key] ?? mod.name}</Text>
            <Text style={styles.moduleKey}>{mod.key}</Text>
          </View>
          {toggling === mod.key ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Switch
              value={mod.enabled}
              onValueChange={(v) => onToggle(mod.key, v)}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor={colors.white}
            />
          )}
        </View>
      ))}
    </ScrollView>
  );
}

// ===========================================================================
// Invoice History tab
// ===========================================================================

function InvoiceHistoryTab() {
  const invoices = useQuery({
    queryKey: ['saInvoices', 'all'],
    queryFn: () => saInvoiceList(),
  });

  return (
    <FlatList
      data={invoices.data ?? []}
      keyExtractor={(i) => i.id}
      contentContainerStyle={styles.scroll}
      refreshControl={
        <RefreshControl
          refreshing={invoices.isRefetching}
          onRefresh={invoices.refetch}
          tintColor={colors.primary}
        />
      }
      ListHeaderComponent={
        <View>
          <Text style={styles.lede}>Every invoice raised against every factory, newest first.</Text>
          {invoices.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
          {invoices.isError ? (
            <Text style={styles.error}>{describeDbError(invoices.error, 'Invoice history')}</Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        !invoices.isLoading ? (
          <EmptyBlock
            title="No invoices yet"
            body="Invoices appear here as each factory's billing cycle is raised."
          />
        ) : null
      }
      renderItem={({ item }) => <InvoiceCard invoice={item} showFactory />}
    />
  );
}

/** Shared by the Invoice History tab and a factory's Payment History screen. */
export function InvoiceCard({
  invoice,
  showFactory,
}: {
  invoice: SaInvoiceRow;
  showFactory?: boolean;
}) {
  return (
    <View style={styles.invoiceCard}>
      <View style={styles.invoiceCardTop}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {showFactory ? (
            <Text style={styles.invoiceFactory} numberOfLines={1}>
              {invoice.factory_name}
            </Text>
          ) : null}
          <Text style={styles.invoiceCode}>{invoice.invoice_code}</Text>
        </View>
        <Text style={styles.invoiceAmount}>{formatMoney(invoice.amount)}</Text>
      </View>
      <View style={styles.invoiceCardBottom}>
        <Text style={styles.invoiceMeta}>
          Issued {formatDate(invoice.issued_on)}
          {invoice.status === 'paid'
            ? ` · paid ${formatDate(invoice.paid_on)}`
            : invoice.due_date
            ? ` · due ${formatDate(invoice.due_date)}`
            : ''}
        </Text>
        {invoiceStatusPill(invoice.status, invoice.due_date)}
      </View>
    </View>
  );
}

// ===========================================================================
// Small shared pieces
// ===========================================================================

function SectionHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

function EmptyBlock({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.emptyBlock}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  banner: { marginBottom: spacing.md },
  lede: {
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  sectionHeading: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  sectionTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Factory row
  factoryRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
  },
  factoryBody: { flex: 1, minWidth: 0 },
  factoryName: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  factorySub: { marginTop: 2, fontSize: fontSize.secondary, color: colors.inkMuted },
  factoryCaption: { marginTop: 1, fontSize: fontSize.caption, color: colors.inkSubtle },
  pills: { gap: spacing.xs, alignItems: 'flex-end' },

  // Billing
  billingCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  billingLabel: {
    fontSize: fontSize.caption,
    color: colors.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  billingAmount: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  billingUnknown: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.inkSubtle,
  },
  billingMeta: { fontSize: fontSize.caption, color: colors.inkMuted },
  subTabs: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  subTabActive: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  subTabActiveText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  invoiceRow: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  invoiceRight: { alignItems: 'flex-end', gap: spacing.xs },
  invoiceFactory: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    color: colors.ink,
  },
  invoiceMeta: { marginTop: 2, fontSize: fontSize.caption, color: colors.inkMuted },
  invoiceAmount: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },

  // Invoice card (history + payment history)
  invoiceCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  invoiceCardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  invoiceCardBottom: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  invoiceCode: {
    marginTop: 2,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
  },

  // Modules
  moduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
  },
  moduleName: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.ink },
  moduleKey: { marginTop: 2, fontSize: fontSize.caption, color: colors.inkMuted },

  // States
  error: { fontSize: fontSize.secondary, color: colors.alert, marginBottom: spacing.sm },
  empty: {
    paddingVertical: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    fontStyle: 'italic',
  },
  emptyBlock: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.ink },
  emptyBody: { fontSize: fontSize.secondary, color: colors.inkMuted, textAlign: 'center' },
});

export default SuperAdminHomeScreen;
