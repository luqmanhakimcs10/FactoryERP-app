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
import { TaskBanners } from '../../components/ui/TaskBanners';
import { MasterCard, CardGrid, type MasterCardProps } from '../../components/ui/MasterCard';
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
import { statCount } from '../../utils/statValue';
import { countOrders } from '../../api/endpoints/orders';
import { countMasters } from '../../api/endpoints/masters';
import { listOrders, countRepeatsByStatus } from '../../api/endpoints/orders';
import { ACTIVE_ORDER_STATUSES } from '../../models/orderTypes';
import { listShiftCloseQueue, listFactoryLeaves } from '../../api/endpoints/shifts';
import { listFactoryDamage } from '../../api/endpoints/orders';
import { matchesSearch } from '../../utils/search';
import { colors, spacing, fontSize } from '../../constants/theme';

export function FloorManagerDashboardScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

  /**
   * The four numbers this role runs the floor by. Every one is a read this
   * dashboard's own screens already make — no new backend was added for them.
   *
   * `countRepeatsByStatus` is a HEAD count rather than a list: the two repeat
   * figures are factory-wide, and pulling every repeat to call `.length` on it
   * is the kind of query a dashboard quietly makes expensive.
   */
  const metrics = useQuery({
    queryKey: ['fmMetrics'],
    queryFn: async () => {
      const [active, awaitingCard, inProduction, stageQa] = await Promise.all([
        listOrders(ACTIVE_ORDER_STATUSES),
        listOrders(['awaiting_job_card', 'job_card_shared']),
        countRepeatsByStatus(['in_progress', 'handed_off', 'handed_over', 'awaiting_dp_collection',
          'returned_to_delivery', 'awaiting_fm_collection']),
        countRepeatsByStatus(['stage_qa']),
      ]);
      return {
        active: active.length,
        awaitingCard: awaitingCard.length,
        inProduction,
        stageQa,
      };
    },
  });

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
              value={statCount(metrics.data?.active)}
              icon="document-text-outline"
              onPress={() => navigation.navigate('OrdersBox')}
            />
            <StatCard
              label="Awaiting job card"
              value={statCount(metrics.data?.awaitingCard)}
              icon="clipboard-outline"
              tone={metrics.data?.awaitingCard ? 'attention' : 'neutral'}
              onPress={() => navigation.navigate('OrdersBox', { tab: 'job_card' })}
            />
            <StatCard
              label="Repeats in production"
              value={statCount(metrics.data?.inProduction)}
              icon="layers-outline"
            />
            <StatCard
              label="Pending stage QA"
              value={statCount(metrics.data?.stageQa)}
              icon="shield-checkmark-outline"
              tone={metrics.data?.stageQa ? 'attention' : 'neutral'}
            />
          </StatGrid>
        </View>

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
    color: colors.accent,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
});

export default FloorManagerDashboardScreen;
