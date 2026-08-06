/**
 * PO Queue — procurement's home.
 *
 * Lists both auto-generated POs (raised by Phase 3's shortfall check at order
 * submission) and manually raised ones, filterable by where each sits in the
 * execution lifecycle.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { SearchBar } from '../../components/lists/SearchBar';
import { StatusPill } from '../../components/ui/StatusPill';
import { listPurchaseOrders } from '../../api/endpoints/inventory';
import { useAuth } from '../../auth/AuthContext';
import { canAccessRole } from '../../utils/permissions';
import { describeDbError } from '../../utils/errors';
import { ROLES } from '../../constants/roles';
import {
  PO_STATUS_LABEL,
  type PurchaseOrder,
  type PoStatus,
} from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

/** Amber = waiting on someone else, indigo = procurement's move, green = done. */
export const PO_STATUS_COLOR: Record<PoStatus, string> = {
  auto_generated: colors.indigo,
  draft: colors.slate,
  executed: colors.indigo,
  awaiting_approval: colors.warning,
  approved: colors.warning,
  paid: colors.indigo,
  handed_over: colors.brass,
  received: colors.success,
  cancelled: colors.alert,
};

type Filter = 'open' | 'waiting' | 'closed' | 'all';

const FILTERS: { key: Filter; label: string; statuses?: string[] }[] = [
  { key: 'open', label: 'To action', statuses: ['auto_generated', 'draft', 'executed', 'paid'] },
  { key: 'waiting', label: 'Waiting', statuses: ['awaiting_approval', 'approved'] },
  { key: 'closed', label: 'Closed', statuses: ['handed_over', 'received', 'cancelled'] },
  { key: 'all', label: 'All' },
];

export function PoQueueScreen() {
  const navigation = useNavigation<any>();
  const { role } = useAuth();
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');

  const canCreate = canAccessRole(role, [ROLES.PROCUREMENT, ROLES.COMPANY_ADMIN]);
  const active = FILTERS.find((f) => f.key === filter)!;

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['purchaseOrders', filter],
    queryFn: () => listPurchaseOrders(active.statuses),
  });

  const rows = useMemo(() => {
    const all = data ?? [];
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter(
      (p) =>
        p.po_code.toLowerCase().includes(q) ||
        (p.suppliers?.name ?? '').toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search PO code or supplier"
        navigation={navigation}
      />

      <View style={styles.banner}><TaskBanners /></View>

      <View style={styles.filters}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => setFilter(f.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: filter === f.key, selected: filter === f.key }}
            {...(Platform.OS === 'web' ? ({ 'aria-checked': filter === f.key } as object) : {})}
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
            onPress={() => navigation.navigate('NewPo')}
            accessibilityLabel="New purchase order"
            accessibilityRole="button"
            style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
          >
            <Text style={styles.newBtnText}>+ New Purchase Order</Text>
          </Pressable>
        </View>
      ) : null}

      {isLoading ? (
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.emptyBody}>{describeDbError(error, 'Purchase order')}</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(p) => p.id}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>Nothing here</Text>
              <Text style={styles.emptyBody}>
                {search
                  ? 'No purchase orders match that search.'
                  : 'Shortfall-triggered POs appear here automatically when an order is submitted.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <PoRow po={item} onPress={() => navigation.navigate('PoDetail', { poId: item.id })} />
          )}
        />
      )}
    </Screen>
  );
}

function PoRow({ po, onPress }: { po: PurchaseOrder; onPress: () => void }) {
  const lines = po.po_items?.length ?? 0;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.code}>{po.po_code}</Text>
        <StatusPill label={PO_STATUS_LABEL[po.status]} color={PO_STATUS_COLOR[po.status]} />
      </View>
      <Text style={styles.supplier} numberOfLines={1}>
        {po.suppliers?.name ?? 'No supplier assigned'}
      </Text>
      <Text style={styles.meta}>
        {lines} line{lines === 1 ? '' : 's'}
        {po.auto_created ? ' · auto-raised on shortfall' : ' · raised manually'}
        {po.orders?.order_code ? ` · for ${po.orders.order_code}` : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: spacing.lg, marginTop: spacing.md },
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
  newBtnText: { color: colors.indigoDeep, fontSize: fontSize.body, fontWeight: fontWeight.semibold },
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
  supplier: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  pressed: { opacity: 0.75 },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center', lineHeight: 20 },
});
