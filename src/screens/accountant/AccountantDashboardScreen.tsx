/**
 * Accountant Dashboard — six cards, nothing else.
 *
 * Same card component as the Company Admin's Masters launcher (MasterCard), so
 * the two cannot drift apart. Five of the six open an accountant-specific view;
 * Finishing Partner deliberately opens the SAME master list + detail screen the
 * Company Admin uses, rather than a second implementation of the same figures.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { MasterCard, CardGrid } from '../../components/ui/MasterCard';
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
import { statCount, statMoney } from '../../utils/statValue';
import { matchesSearch } from '../../utils/search';
import { countMasters } from '../../api/endpoints/masters';
import { countEmployees } from '../../api/endpoints/employees';
import {
  countInvoices,
  getReceivableSummary,
  getSalaryOutstanding,
  listPayableSupplierPos,
  listPayablePartners,
} from '../../api/endpoints/accounting';
import { colors, spacing, fontSize } from '../../constants/theme';

interface CardConfig {
  key: 'clients' | 'suppliers' | 'finishing_partners' | 'employees' | 'machines' | 'invoices';
  label: string;
  subtitle: string;
  icon: string;
  accent: string;
  route: string;
  params?: Record<string, unknown>;
}

const CARDS: CardConfig[] = [
  {
    key: 'clients',
    label: 'Clients',
    subtitle: 'Billing, invoices and damages',
    icon: 'people-outline',
    accent: colors.primary,
    route: 'AcctClients',
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    subtitle: 'Purchase orders and billing dates',
    icon: 'cube-outline',
    accent: colors.primary,
    route: 'AcctSuppliers',
  },
  {
    key: 'finishing_partners',
    label: 'Finishing Partner',
    subtitle: 'Repeats, damages and partner income',
    icon: 'cut-outline',
    accent: colors.primary,
    route: 'MasterList',
    params: { entity: 'finishing_partners' },
  },
  {
    key: 'employees',
    label: 'Employees',
    subtitle: 'Every role: salary, bonus, fines, leave',
    icon: 'person-circle-outline',
    accent: colors.primary,
    route: 'AcctEmployees',
  },
  {
    key: 'machines',
    label: 'Machines',
    subtitle: 'Registry and hours run',
    icon: 'cog-outline',
    accent: colors.primary,
    route: 'AcctMachines',
  },
  {
    key: 'invoices',
    label: 'Invoices',
    subtitle: 'Receivable and payable',
    icon: 'document-text-outline',
    accent: colors.primary,
    route: 'AcctInvoices',
  },
];

export function AccountantDashboardScreen() {
  /**
   * PAYABLES DUE is suppliers + finishing partners — the two ledgers the
   * accountant's own Invoices screen already loads. Approved expenses are NOT
   * in it: `acct_payable_expenses` is per-category, so folding them in would be
   * two more round-trips on a dashboard for a figure the Invoices screen breaks
   * out properly anyway.
   */
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

  const metrics = useQuery({
    queryKey: ['accountantMetrics'],
    queryFn: async () => {
      const [receivable, salary, supplierPos, partners] = await Promise.all([
        getReceivableSummary().catch(() => null),
        getSalaryOutstanding().catch(() => null),
        listPayableSupplierPos().catch(() => []),
        listPayablePartners().catch(() => []),
      ]);
      const supplierDue = supplierPos.reduce((n, p) => n + Number(p.amount ?? 0), 0);
      // `payable` is the field `acct_payable_partners` returns — typed, so a
      // rename breaks the build rather than silently summing zero.
      const partnerDue = partners.reduce((n, p) => n + Number(p.payable ?? 0), 0);
      return {
        payables: supplierDue + partnerDue,
        receivables: receivable?.pending ?? 0,
        posAwaitingPayment: supplierPos.length,
        pendingSalaries: salary?.pending_count ?? 0,
      };
    },
  });

  const { data, isError } = useQuery({
    queryKey: ['accountantCardCounts'],
    queryFn: async () => {
      const [clients, suppliers, partners, machines, employees, invoices] = await Promise.all([
        countMasters('vendors'),
        countMasters('suppliers'),
        countMasters('finishing_partners'),
        countMasters('machines'),
        countEmployees(),
        countInvoices(),
      ]);
      return { clients, suppliers, partners, machines, employees, invoices };
    },
  });

  function countFor(key: CardConfig['key']): number | null {
    if (!data) return null;
    switch (key) {
      case 'clients': return data.clients;
      case 'suppliers': return data.suppliers;
      case 'finishing_partners': return data.partners;
      case 'employees': return data.employees;
      case 'machines': return data.machines;
      case 'invoices': return data.invoices;
    }
  }

  const visible = useMemo(
    () => CARDS.filter((c) => matchesSearch(search, c.label, c.subtitle)),
    [search]
  );

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search sections"
        navigation={navigation}
      />
      <ScrollView contentContainerStyle={styles.container}>
        <TaskBanners />

        <View style={styles.metrics}>
          <StatGrid>
            <StatCard
              label="Payables due"
              value={metrics.isError ? '—' : statMoney(metrics.data?.payables)}
              icon="arrow-up-circle-outline"
              tone={(metrics.data?.payables ?? 0) > 0 ? 'attention' : 'neutral'}
            />
            <StatCard
              label="Receivables due"
              value={metrics.isError ? '—' : statMoney(metrics.data?.receivables)}
              icon="arrow-down-circle-outline"
            />
            <StatCard
              label="POs awaiting payment"
              value={statCount(metrics.data?.posAwaitingPayment)}
              icon="document-text-outline"
              tone={metrics.data?.posAwaitingPayment ? 'attention' : 'neutral'}
            />
            <StatCard
              label="Pending salary runs"
              value={statCount(metrics.data?.pendingSalaries)}
              icon="people-outline"
              tone={metrics.data?.pendingSalaries ? 'attention' : 'neutral'}
            />
          </StatGrid>
        </View>
        <CardGrid>
          {visible.map((card) => (
            <MasterCard
              key={card.key}
              label={card.label}
              subtitle={card.subtitle}
              icon={card.icon}
              accent={card.accent}
              count={countFor(card.key)}
              onPress={() => navigation.navigate(card.route, card.params)}
            />
          ))}
        </CardGrid>
        {visible.length === 0 ? (
          <Text style={styles.empty}>No sections match “{search}”.</Text>
        ) : null}
        {isError ? <Text style={styles.error}>Unable to load counts.</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  metrics: { marginBottom: spacing.lg },
  container: { padding: spacing.lg, paddingTop: spacing.xl },
  banner: { marginBottom: spacing.lg },
  empty: {
    paddingTop: spacing.xl,
    color: colors.inkMuted,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
  error: {
    paddingTop: spacing.md,
    color: colors.alert,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
});

export default AccountantDashboardScreen;
