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
import { ActionBanner } from '../../components/ui/ActionBanner';
import { MasterCard, CardGrid } from '../../components/ui/MasterCard';
import { matchesSearch } from '../../utils/search';
import { countMasters } from '../../api/endpoints/masters';
import { countEmployees } from '../../api/endpoints/employees';
import { countInvoices } from '../../api/endpoints/accounting';
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
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

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

  // Receivables are the accountant's most actionable queue: an unpaid invoice is
  // money owed to the factory. `countInvoices` already backs the Invoices card,
  // so this reuses a number the dashboard has rather than fetching a new one.
  const invoices = data?.invoices ?? 0;
  const banner =
    invoices > 0
      ? {
          title: `${invoices} invoice${invoices === 1 ? '' : 's'} on the books`,
          subtitle: 'Receivable and payable — review what is outstanding',
          onPress: () => navigation.navigate('AcctInvoices'),
        }
      : null;

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search sections"
        navigation={navigation}
      />
      <ScrollView contentContainerStyle={styles.container}>
        {banner ? <ActionBanner {...banner} style={styles.banner} /> : null}
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
