/**
 * Procurement's home — two tabs, and no buttons.
 *
 * The role's scope was cut to view / save / download in 0089. It used to own the
 * PO lifecycle (execute, upload the supplier bill, confirm handover) behind four
 * status filters; the store manager procures and the accountant pays now, so
 * every one of those actions is gone and the four filters collapse to the only
 * two questions this role still asks: is it settled, or is it not.
 *
 *   Pending   — Creation or Procured. Money still owed, goods still coming.
 *   Completed — Paid, Received, or Cancelled. Nothing further to expect.
 *
 * The buckets are decided in SQL (`proc_po_list`) rather than by filtering a
 * full list here: a read-only role should not be shipped the rows it has no
 * business acting on, and a client-side split is one edit away from becoming a
 * client-side rule.
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
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { SearchBar } from '../../components/lists/SearchBar';
import { StatusPill } from '../../components/ui/StatusPill';
import { MetricCard, MetricRow, MetricsSection } from '../../components/ui/MetricCard';
import { statCount } from '../../utils/statValue';
import { listProcurementPos, type ProcurementPoRow } from '../../api/endpoints/inventory';
import { matchesSearch } from '../../utils/search';
import { describeDbError } from '../../utils/errors';
import { PO_STATUS_LABEL, poFlowStep, type PoStatus } from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

/**
 * Colour by which of the three steps the PO is at, not by raw status.
 *
 * A `Record<PoStatus, string>` used to live here and had to be extended every
 * time a status was added or retired — including four retired ones that would
 * otherwise need entries for no reason other than to satisfy the type.
 */
export function poStatusColor(status: PoStatus): string {
  if (status === 'cancelled') return colors.alert;
  if (status === 'received') return colors.success;
  return [colors.inkMuted, colors.accent, colors.primary][poFlowStep(status)];
}

type Bucket = 'pending' | 'completed';

export function PoQueueScreen() {
  const navigation = useNavigation<any>();
  const [bucket, setBucket] = useState<Bucket>('pending');
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['procurementPos', bucket],
    queryFn: () => listProcurementPos(bucket),
  });

  /*
   * The OTHER bucket, for its count alone.
   *
   * The visible list is fetched per tab, so the tab you are not on has no data
   * to count. Keyed identically to the list query, so switching tabs reuses
   * whichever of the two React Query already holds rather than refetching.
   */
  const other = useQuery({
    queryKey: ['procurementPos', bucket === 'pending' ? 'completed' : 'pending'],
    queryFn: () => listProcurementPos(bucket === 'pending' ? 'completed' : 'pending'),
  });

  const pendingCount = bucket === 'pending' ? data?.length : other.data?.length;
  const completedCount = bucket === 'completed' ? data?.length : other.data?.length;

  const rows = useMemo(
    () =>
      (data ?? []).filter((p) =>
        matchesSearch(search, p.po_code, p.supplier_name ?? '', p.order_code ?? '')
      ),
    [data, search]
  );

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search PO, supplier or order"
        navigation={navigation}
      />

      <SegmentedTabs
        value={bucket}
        onChange={(k) => setBucket(k as Bucket)}
        tabs={[
          { key: 'pending', label: 'Pending' },
          { key: 'completed', label: 'Completed' },
        ]}
      />

      <FlatList
        data={rows}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
        }
        ListHeaderComponent={
          <View>
            <TaskBanners />

            <View style={styles.metrics}>
              <MetricsSection subtitle="Purchase orders, settled and not">
                <MetricRow>
                  <MetricCard
                    label="Pending POs"
                    value={statCount(pendingCount)}
                    icon="document-text-outline"
                    accent={pendingCount ? 'amber' : 'teal'}
                    onPress={() => setBucket('pending')}
                  />
                  <MetricCard
                    label="Completed POs"
                    value={statCount(completedCount)}
                    icon="checkmark-done-outline"
                    accent="green"
                    onPress={() => setBucket('completed')}
                  />
                </MetricRow>
              </MetricsSection>
            </View>
            <Text style={styles.lede}>
              {bucket === 'pending'
                ? 'Raised or bought, not yet paid. Open one to read it, save it or send it on.'
                : 'Paid, received or cancelled — nothing further is expected on these.'}
            </Text>
            {isLoading ? <ActivityIndicator color={colors.primary} /> : null}
            {isError ? (
              <Text style={styles.error}>{describeDbError(error, 'Purchase orders')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>
                {bucket === 'pending' ? 'Nothing outstanding' : 'Nothing completed yet'}
              </Text>
              <Text style={styles.emptyBody}>
                {search
                  ? `No purchase order matches “${search}”.`
                  : bucket === 'pending'
                  ? 'Purchase orders appear here as the store manager raises them.'
                  : 'A purchase order lands here once the accountant has paid it.'}
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => <PoRow row={item} onPress={() => navigation.navigate('PoDetail', { poId: item.id })} />}
      />
    </Screen>
  );
}

function PoRow({ row, onPress }: { row: ProcurementPoRow; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.code}>{row.po_code}</Text>
        <StatusPill label={PO_STATUS_LABEL[row.status] ?? row.status} color={poStatusColor(row.status)} />
      </View>
      <Text style={styles.supplier} numberOfLines={1}>
        {row.supplier_name ?? 'No supplier assigned'}
      </Text>
      <Text style={styles.meta}>
        {row.line_count} line{row.line_count === 1 ? '' : 's'} ·{' '}
        <Text style={styles.mono}>{Number(row.total_quantity).toLocaleString()}</Text>
        {row.amount ? (
          <>
            {' · '}
            <Text style={styles.mono}>{Number(row.amount).toLocaleString()}</Text>
          </>
        ) : null}
        {row.order_code ? ` · ${row.order_code}` : ''}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  metrics: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  list: { paddingBottom: spacing.xxl },
  lede: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    lineHeight: 20,
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
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  supplier: { fontSize: fontSize.secondary, color: colors.ink },
  meta: { fontSize: fontSize.caption, color: colors.inkMuted },
  mono: { fontFamily: fontFamily.mono },
  error: { paddingHorizontal: spacing.lg, fontSize: fontSize.secondary, color: colors.alert },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.ink },
  emptyBody: { fontSize: fontSize.secondary, color: colors.inkMuted, textAlign: 'center' },
});
