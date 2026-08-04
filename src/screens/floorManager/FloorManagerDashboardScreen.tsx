/**
 * Floor Manager Dashboard — five navigation sections, as a 2-column grid.
 *
 * These are NAVIGATION MENU CARDS (tap to go elsewhere), so they use
 * `MasterCard`'s grid layout. They used to render as five full-width stacked
 * rows, which is the row layout meant for lists of RECORDS inside a section —
 * see MasterCard's header for the distinction.
 *
 * Each box owns a screen that relocates existing functionality (machine
 * assignment, shift close, job card builder) rather than rebuilding it.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { MasterCard, CardGrid, type MasterCardProps } from '../../components/ui/MasterCard';
import { countOrders, listOrders } from '../../api/endpoints/orders';
import { countMasters } from '../../api/endpoints/masters';
import { listShiftCloseQueue, listFactoryLeaves } from '../../api/endpoints/shifts';
import { listPendingMaterialAcceptance } from '../../api/endpoints/inventory';
import { listFactoryDamage } from '../../api/endpoints/orders';
import { matchesSearch } from '../../utils/search';
import type { OrderStatus } from '../../models/orderTypes';
import { colors, spacing, fontSize } from '../../constants/theme';

const JOB_CARD_STATUSES: OrderStatus[] = ['awaiting_job_card', 'job_card_shared'];

export function FloorManagerDashboardScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

  const { data, isError } = useQuery({
    queryKey: ['floorManagerCardCounts'],
    queryFn: async () => {
      const [orders, machines, closeQueue, leaves, damage] = await Promise.all([
        countOrders(),
        countMasters('machines'),
        listShiftCloseQueue(),
        listFactoryLeaves('pending'),
        listFactoryDamage(),
      ]);
      return {
        orders,
        machines,
        openShifts: closeQueue.length,
        pendingLeaves: leaves.length,
        damage: damage.length,
      };
    },
  });

  // Banner data — both already fetched elsewhere on this role's screens, so
  // this surfaces existing queues rather than introducing new logic.
  const { data: jobCardQueue } = useQuery({
    queryKey: ['orders', 'fmJobCard'],
    queryFn: () => listOrders(JOB_CARD_STATUSES),
  });
  const { data: pendingMaterial } = useQuery({
    queryKey: ['pendingMaterialAcceptance'],
    queryFn: listPendingMaterialAcceptance,
  });

  const cards: (MasterCardProps & { key: string })[] = [
    {
      key: 'orders',
      label: 'Orders',
      subtitle: 'Active orders, awaiting job card, accept inventory',
      icon: 'document-text-outline',
      accent: colors.primary,
      count: data?.orders ?? null,
      onPress: () => navigation.navigate('OrdersBox'),
    },
    {
      key: 'machine',
      label: 'Machine & Workforce',
      subtitle: 'Machines, assignment, and the shift calendar',
      icon: 'cog-outline',
      accent: colors.primary,
      count: data?.machines ?? null,
      onPress: () => navigation.navigate('MachineWorkforce'),
    },
    {
      key: 'shiftClose',
      label: 'Shift close',
      subtitle: 'Shift close walk',
      icon: 'time-outline',
      accent: colors.accent,
      count: data?.openShifts ?? null,
      onPress: () => navigation.navigate('ShiftCloseQueue'),
    },
    {
      key: 'leave',
      label: 'Leave',
      subtitle: 'Worker leave requests',
      icon: 'calendar-outline',
      accent: colors.primary,
      count: data?.pendingLeaves ?? null,
      onPress: () => navigation.navigate('LeaveBox'),
    },
    {
      key: 'damages',
      label: 'Damages',
      subtitle: 'Orders, materials and other tracked loss',
      icon: 'alert-circle-outline',
      accent: colors.accent,
      count: data?.damage ?? null,
      onPress: () => navigation.navigate('DamagesBox'),
    },
  ];

  const visible = useMemo(
    () => cards.filter((c) => matchesSearch(search, c.label, c.subtitle)),
    [search, data]
  );

  // The most actionable queue wins the banner: material sitting in the store is
  // blocking production RIGHT NOW, whereas a job card is the floor manager's own
  // next task. Nothing outstanding -> no banner, rather than a hollow one.
  const material = pendingMaterial?.length ?? 0;
  const jobCards = jobCardQueue?.length ?? 0;
  const banner =
    material > 0
      ? {
          title: `${material} order${material === 1 ? '' : 's'} ready to accept inventory`,
          subtitle: 'Materials are waiting in the store — accept to start production',
          onPress: () => navigation.navigate('OrdersBox'),
        }
      : jobCards > 0
        ? {
            title: `${jobCards} order${jobCards === 1 ? '' : 's'} awaiting a job card`,
            subtitle: 'Set the stage sequence so production can be planned',
            onPress: () => navigation.navigate('OrdersBox'),
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
          {visible.map(({ key, ...card }) => (
            <MasterCard key={key} {...card} />
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
    color: colors.accent,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
});

export default FloorManagerDashboardScreen;
