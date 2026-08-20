/**
 * Order Taker Dashboard — one button and exactly two boxes.
 *
 * "+ New Order" sits at the top and is always visible: capturing an order is
 * this role's whole job, and it should never be more than one tap away. Below
 * it, the same MasterCard used by the Company Admin's Masters screen and the
 * Accountant's dashboard, so all three launchers stay one component.
 *
 * Neither box is new work: Orders opens the Phase 3 list, Returns opens a
 * read-only view over Phase 6's stage-tracking data.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { MasterCard, CardGrid, type MasterCardProps } from '../../components/ui/MasterCard';
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
import { statCount } from '../../utils/statValue';
import { matchesSearch } from '../../utils/search';
import { countOrders, listReturnRepeats, listOrders } from '../../api/endpoints/orders';
import { ACTIVE_ORDER_STATUSES } from '../../models/orderTypes';
import { useAuth } from '../../auth/AuthContext';
import { ROLES } from '../../constants/roles';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

export function OrderTakerDashboardScreen() {
  const navigation = useNavigation<any>();
  const { role } = useAuth();
  const [search, setSearch] = useState('');

  // The merged Order/Delivery Person lands here too. Their delivery work is a
  // third card rather than a second dashboard: it is the same launcher, and
  // the list it opens is the delivery person's existing single-tab Orders list.
  const isOrderDelivery = role === ROLES.ORDER_DELIVERY;

  const orders = useQuery({ queryKey: ['orderCount'], queryFn: countOrders });
  // Both reads are already scoped to this order taker's own orders by
  // `ot_return_repeats` and by RLS, so the numbers are theirs, not the floor's.
  const activeOrders = useQuery({
    queryKey: ['orders', 'otActive'],
    queryFn: () => listOrders(ACTIVE_ORDER_STATUSES),
  });
  const awaitingInspection = useQuery({
    queryKey: ['orders', 'otAwaitingInspection'],
    queryFn: () => listOrders(['awaiting_cloth_inspection']),
  });
  const returns = useQuery({ queryKey: ['returnRepeats'], queryFn: listReturnRepeats });

  const activeCount = returns.data
    ? returns.data.filter((r) => r.bucket === 'active').length
    : null;

  const cards: (MasterCardProps & { key: string })[] = [
    {
      key: 'orders',
      label: 'Orders',
      subtitle: 'Every order you have captured',
      icon: 'document-text-outline',
      accent: colors.primary,
      count: orders.data ?? null,
      onPress: () => navigation.navigate('MyOrders'),
    },
    {
      key: 'returns',
      label: 'Returns',
      subtitle: 'Finishing stages, returns and handover',
      icon: 'swap-horizontal-outline',
      accent: colors.primary,
      count: activeCount,
      onPress: () => navigation.navigate('Returns'),
    },
    ...(isOrderDelivery
      ? [
          {
            key: 'deliveries',
            label: 'Deliveries',
            subtitle: 'Collect, deliver and pick up pieces',
            icon: 'bicycle-outline',
            accent: colors.primary,
            count: null,
            onPress: () => navigation.navigate('DeliveryOrders'),
          } as MasterCardProps & { key: string },
        ]
      : []),
  ];

  const visible = useMemo(
    () => cards.filter((c) => matchesSearch(search, c.label, c.subtitle)),
    [search, orders.data, activeCount, isOrderDelivery]
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
        <Pressable
          onPress={() => navigation.navigate('NewOrder')}
          accessibilityRole="button"
          accessibilityLabel="New order"
          style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
        >
          <Text style={styles.newBtnText}>+ New Order</Text>
        </Pressable>

        <TaskBanners />

        <View style={styles.metrics}>
          <StatGrid>
            <StatCard
              label="Active orders"
              value={statCount(activeOrders.data?.length)}
              icon="document-text-outline"
              onPress={() => navigation.navigate('MyOrders')}
            />
            <StatCard
              label="Awaiting cloth inspection"
              value={statCount(awaitingInspection.data?.length)}
              icon="shield-checkmark-outline"
            />
            <StatCard
              label="Active returns"
              value={statCount(activeCount ?? undefined)}
              icon="swap-horizontal-outline"
              tone={activeCount ? 'attention' : 'neutral'}
              onPress={() => navigation.navigate('Returns')}
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
        {orders.isError || returns.isError ? (
          <Text style={styles.error}>Unable to load counts.</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  metrics: { marginBottom: spacing.lg },
  container: { padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.lg },
  banner: { marginTop: spacing.xs },
  empty: {
    paddingTop: spacing.xl,
    color: colors.inkMuted,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
  newBtn: {
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
  },
  newBtnText: {
    fontFamily: fontFamily.display,
    color: colors.white,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
  },
  pressed: { opacity: 0.75 },
  cards: { gap: spacing.md },
  error: {
    color: colors.alert,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
});

export default OrderTakerDashboardScreen;
