/**
 * QA Inspection Queue — orders awaiting incoming cloth inspection, plus orders
 * that have been accepted and still need repeat coding.
 *
 * Queue counts are per-factory by RLS, so a badge can never include another
 * tenant's work.
 */
import React from 'react';
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
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { listOrders } from '../../api/endpoints/orders';
import { describeDbError } from '../../utils/errors';
import type { OrderListRow } from '../../models/orderTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

/** Both buckets QA owns: inspection first, then coding. */
const QA_STATUSES = ['awaiting_cloth_inspection', 'awaiting_coding'];

export function InspectionQueueScreen() {
  const navigation = useNavigation<any>();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['orders', 'qaQueue'],
    queryFn: () => listOrders(QA_STATUSES),
  });

  const rows = data ?? [];
  const toInspect = rows.filter((o) => o.status === 'awaiting_cloth_inspection').length;
  const toCode = rows.filter((o) => o.status === 'awaiting_coding').length;

  return (
    <Screen padded={false}>
      <View style={styles.summary}>
        <Counter label="Awaiting inspection" value={toInspect} />
        <Counter label="Awaiting coding" value={toCode} />
      </View>

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
              <Text style={styles.emptyTitle}>Queue is clear</Text>
              <Text style={styles.emptyBody}>
                No orders are waiting on inspection or coding.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <QueueRow
              order={item}
              onPress={() =>
                navigation.navigate(
                  item.status === 'awaiting_cloth_inspection' ? 'ClothInspection' : 'OrderQa',
                  { orderId: item.id }
                )
              }
            />
          )}
        />
      )}
    </Screen>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.counter}>
      <Text style={styles.counterValue}>{value}</Text>
      <Text style={styles.counterLabel}>{label}</Text>
    </View>
  );
}

function QueueRow({ order, onPress }: { order: OrderListRow; onPress: () => void }) {
  const action = order.status === 'awaiting_cloth_inspection' ? 'Inspect cloth' : 'Repeat QA';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.code}>{order.order_code}</Text>
        <OrderStatusPill status={order.status} />
      </View>
      <Text style={styles.vendor} numberOfLines={1}>
        {order.vendor_name}
      </Text>
      <Text style={styles.meta}>
        {order.sheet_count} sheet{order.sheet_count === 1 ? '' : 's'} ·{' '}
        <Text style={styles.mono}>{order.repeat_total}</Text> repeats to code
      </Text>
      <Text style={styles.action}>{action} →</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  counter: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  counterValue: {
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    fontFamily: fontFamily.mono,
  },
  counterLabel: { fontSize: fontSize.caption, color: colors.slate },
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
  action: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.brass, fontWeight: fontWeight.semibold },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
