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
import { matchesSearch } from '../../utils/search';
import { countEmployees } from '../../api/endpoints/employees';
import { countMasters } from '../../api/endpoints/masters';
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
  container: { padding: spacing.lg, paddingTop: spacing.xl },
  banner: { marginBottom: spacing.lg },
  empty: { paddingTop: spacing.xl, color: colors.inkMuted, fontSize: fontSize.secondary, textAlign: 'center' },
  error: { paddingTop: spacing.md, color: colors.alert, fontSize: fontSize.secondary, textAlign: 'center' },
});

export default MastersTabsScreen;
