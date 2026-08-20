/**
 * Masters Launcher — one screen with five cards for the master entities.
 *
 * This screen intentionally renders exactly five cards only. Each card opens the
 * matching detailed master list or employee management screen without any extra
 * nested sections, tabs, or secondary landing content.
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
import { countEmployees } from '../../api/endpoints/employees';
import { countMasters } from '../../api/endpoints/masters';
import { listOrders, listFactoryDamage } from '../../api/endpoints/orders';
import { getApprovalsQueue, listInvoices } from '../../api/endpoints/finance';
import { ACTIVE_ORDER_STATUSES } from '../../models/orderTypes';
import { colors, spacing, fontSize } from '../../constants/theme';

interface MasterCardConfig {
  key: 'vendors' | 'suppliers' | 'machines' | 'finishing_partners' | 'employees';
  label: string;
  subtitle: string;
  icon: string;
  accent: string;
  route: string;
}

const CARDS: MasterCardConfig[] = [
  {
    key: 'vendors',
    label: 'Client',
    subtitle: 'Customers who place orders',
    icon: 'people-outline',
    accent: colors.primary,
    route: 'MasterList',
  },
  {
    key: 'suppliers',
    label: 'Supplier',
    subtitle: 'Thread and material sellers',
    icon: 'cube-outline',
    accent: colors.primary,
    route: 'MasterList',
  },
  {
    key: 'machines',
    label: 'Machine',
    subtitle: 'Machine registry',
    icon: 'cog-outline',
    accent: colors.primary,
    route: 'MasterList',
  },
  {
    key: 'finishing_partners',
    label: 'Finishing Partner',
    subtitle: 'External finishing contractors',
    icon: 'cut-outline',
    accent: colors.primary,
    route: 'MasterList',
  },
  {
    key: 'employees',
    label: 'Employees',
    subtitle: 'Add and manage staff',
    icon: 'person-circle-outline',
    accent: colors.primary,
    route: 'EmployeeManagement',
  },
];

export function MastersTabsScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

  /**
   * The owner's four. Each is a read one of their own screens already makes.
   *
   * REVENUE THIS MONTH is INVOICED this month, from `invoices.issued_at` — the
   * closest live figure without running the P&L report, which is a heavier
   * query and module-gated behind finance_reports. Money actually collected is
   * on the accountant's Receivables screen; this card is what the factory
   * billed, which is what an owner glances at.
   */
  const metrics = useQuery({
    queryKey: ['ownerMetrics'],
    queryFn: async () => {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const [active, approvals, damage, invoices] = await Promise.all([
        listOrders(ACTIVE_ORDER_STATUSES),
        getApprovalsQueue().catch(() => []),
        listFactoryDamage().catch(() => []),
        listInvoices().catch(() => []),
      ]);

      return {
        activeOrders: active.length,
        approvals: approvals.length,
        damage: damage.length,
        revenue: invoices
          .filter((i) => i.status !== 'cancelled' && new Date(i.issued_at) >= monthStart)
          .reduce((n, i) => n + Number(i.amount ?? 0), 0),
      };
    },
  });

  const { data, isError } = useQuery({
    queryKey: ['masterCardCounts'],
    queryFn: async () => {
      const [vendors, suppliers, machines, finishingPartners, employees] = await Promise.all([
        countMasters('vendors'),
        countMasters('suppliers'),
        countMasters('machines'),
        countMasters('finishing_partners'),
        countEmployees(),
      ]);
      return { vendors, suppliers, machines, finishingPartners, employees };
    },
  });

  const counts = data ?? {
    vendors: null,
    suppliers: null,
    machines: null,
    finishingPartners: null,
    employees: null,
  };

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
              label="Active orders"
              value={statCount(metrics.data?.activeOrders)}
              icon="document-text-outline"
            />
            <StatCard
              label="Invoiced this month"
              value={metrics.isError ? '—' : statMoney(metrics.data?.revenue)}
              icon="cash-outline"
            />
            <StatCard
              label="Pending approvals"
              value={statCount(metrics.data?.approvals)}
              icon="checkmark-done-outline"
              tone={metrics.data?.approvals ? 'attention' : 'neutral'}
              onPress={() => navigation.navigate('ApprovalsInbox')}
            />
            <StatCard
              label="Damage records"
              value={statCount(metrics.data?.damage)}
              icon="alert-circle-outline"
              tone={metrics.data?.damage ? 'attention' : 'neutral'}
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
              count={
                card.key === 'vendors'
                  ? counts.vendors
                  : card.key === 'suppliers'
                  ? counts.suppliers
                  : card.key === 'machines'
                  ? counts.machines
                  : card.key === 'finishing_partners'
                  ? counts.finishingPartners
                  : counts.employees
              }
              onPress={() =>
                navigation.navigate(
                  card.route,
                  card.route === 'MasterList' ? { entity: card.key } : undefined
                )
              }
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
  empty: { paddingTop: spacing.xl, color: colors.inkMuted, fontSize: fontSize.secondary, textAlign: 'center' },
  error: { paddingTop: spacing.md, color: colors.alert, fontSize: fontSize.secondary, textAlign: 'center' },
});

export default MastersTabsScreen;
