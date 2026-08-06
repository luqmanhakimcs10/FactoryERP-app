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
import { matchesSearch } from '../../utils/search';
import { countOrders, listReturnRepeats } from '../../api/endpoints/orders';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

export function OrderTakerDashboardScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

  const orders = useQuery({ queryKey: ['orderCount'], queryFn: countOrders });
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
  ];

  const visible = useMemo(
    () => cards.filter((c) => matchesSearch(search, c.label, c.subtitle)),
    [search, orders.data, activeCount]
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
