/**
 * My Orders — the order taker's home list, filterable by lifecycle bucket.
 * Also used read-only by the owner.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { SearchBar } from '../../components/lists/SearchBar';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { listOrders } from '../../api/endpoints/orders';
import { useAuth } from '../../auth/AuthContext';
import { canAccessRole } from '../../utils/permissions';
import { describeDbError } from '../../utils/errors';
import { ROLES } from '../../constants/roles';
import type { OrderListRow, SubmitResult } from '../../models/orderTypes';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  fontFamily,
  radius,
} from '../../constants/theme';

type Filter = 'all' | 'draft' | 'in_progress' | 'completed';

const FILTERS: { key: Filter; label: string; statuses?: string[] }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft', statuses: ['draft'] },
  {
    key: 'in_progress',
    label: 'In progress',
    statuses: [
      'awaiting_procurement',
      'awaiting_cloth_inspection',
      'awaiting_coding',
      'awaiting_job_card',
      'job_card_shared',
    ],
  },
  { key: 'completed', label: 'Confirmed', statuses: ['job_card_confirmed'] },
];

export function MyOrdersScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { role } = useAuth();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  // Just-submitted outcome of the thread check, handed off from NewOrderScreen.
  // Cleared from route params immediately so it doesn't reappear on a later visit.
  const [justSubmitted, setJustSubmitted] = useState<SubmitResult | null>(null);
  useEffect(() => {
    const incoming = route.params?.justSubmitted as SubmitResult | undefined;
    if (incoming) {
      setJustSubmitted(incoming);
      navigation.setParams({ justSubmitted: undefined });
    }
  }, [route.params?.justSubmitted]);

  const canCreate = canAccessRole(role, [ROLES.ORDER_TAKER, ROLES.COMPANY_ADMIN]);
  const active = FILTERS.find((f) => f.key === filter)!;

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['orders', filter],
    queryFn: () => listOrders(active.statuses),
  });

  // Client-side text filter: the list is per-factory and small enough.
  const rows = useMemo(() => {
    const all = data ?? [];
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter(
      (o) =>
        (o.order_code ?? '').toLowerCase().includes(q) ||
        o.vendor_name.toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <Screen padded={false}>
      {justSubmitted ? (
        <View style={styles.bannerWrap}>
          <ActionBanner
            tone={justSubmitted.status === 'awaiting_procurement' ? 'attention' : 'neutral'}
            title={
              justSubmitted.status === 'awaiting_procurement'
                ? 'Order submitted — thread shortfall, procurement notified'
                : 'Order submitted — thread stock is sufficient'
            }
            subtitle={
              justSubmitted.status === 'awaiting_procurement'
                ? `Purchase order ${justSubmitted.po_code} was raised automatically.`
                : 'The order is queued for incoming cloth inspection.'
            }
          />
          <Pressable
            onPress={() => setJustSubmitted(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            hitSlop={8}
            style={styles.bannerDismiss}
          >
            <Text style={styles.bannerDismissText}>Dismiss</Text>
          </Pressable>
        </View>
      ) : null}

      <SearchBar value={search} onChangeText={setSearch} placeholder="Search code or vendor" />

      <View style={styles.filters}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => setFilter(f.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: filter === f.key, selected: filter === f.key }}
            {...(typeof window !== 'undefined' ? { 'aria-checked': filter === f.key } : {})}
            style={({ pressed }) => [
              styles.filter,
              filter === f.key && styles.filterOn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.filterText, filter === f.key && styles.filterTextOn]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {canCreate ? (
        <View style={styles.newRow}>
          <Pressable
            onPress={() => navigation.navigate('NewOrder')}
            accessibilityLabel="New order"
            accessibilityRole="button"
            style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
          >
            <Text style={styles.newBtnText}>+ New Order</Text>
          </Pressable>
        </View>
      ) : null}

      {isLoading ? (
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.emptyBody}>{describeDbError(error, 'Order')}</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(o) => o.id}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No orders here</Text>
              <Text style={styles.emptyBody}>
                {search
                  ? 'No orders match that search.'
                  : canCreate
                    ? 'Tap "+ New Order" to capture one.'
                    : 'Nothing to show yet.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <OrderRow
              order={item}
              onPress={() => navigation.navigate('OrderDetail', { orderId: item.id })}
            />
          )}
        />
      )}
    </Screen>
  );
}

function OrderRow({ order, onPress }: { order: OrderListRow; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.code}>{order.order_code ?? '(draft)'}</Text>
        <OrderStatusPill status={order.status} />
      </View>
      <Text style={styles.vendor} numberOfLines={1}>
        {order.vendor_name}
      </Text>
      {/* Created date, order number, company and status are what the row must
          carry; sheets/repeats stay as the supporting detail. */}
      <Text style={styles.meta}>
        {new Date(order.created_at).toLocaleDateString()} · {order.sheet_count} sheet
        {order.sheet_count === 1 ? '' : 's'} ·{' '}
        <Text style={styles.mono}>{order.repeat_total}</Text> repeats
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The banner owns its own shape; this only positions it and its dismiss link.
  bannerWrap: { margin: spacing.lg, marginBottom: spacing.sm },
  bannerDismiss: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  bannerDismissText: { fontSize: fontSize.caption, color: colors.indigo, fontWeight: fontWeight.medium },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  filter: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  filterText: { fontSize: fontSize.caption, color: colors.slate, fontWeight: fontWeight.medium },
  filterTextOn: { color: colors.white },
  newRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  newBtn: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.brass,
  },
  newBtnText: {
    color: colors.indigoDeep,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
  },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  vendor: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono },
  pressed: { opacity: 0.75 },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
