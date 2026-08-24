/**
 * Inspection Queue — the Inspector's single entry point into the flow.
 *
 * ONE LIST, ONE DESTINATION, AND NOW ONE ACTION. It used to carry two counters
 * (awaiting inspection / awaiting coding) and route each row to a different
 * screen; 0087 made both buckets steps inside `OrderQa`. 0092 removes the
 * remaining difference between them — tapping any row goes straight into Start
 * QA, whichever of the two statuses the order is in, because there is no longer
 * a cloth-acceptance step to do first.
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

/**
 * "Nobody has looked yet" and "inspection under way". Two statuses, one job:
 * the first piece decision moves an order from the first to the second without
 * anyone pressing anything (see `qa_open_inspection`, 0092).
 */
const QA_STATUSES = ['awaiting_cloth_inspection', 'awaiting_coding'];

export function InspectionQueueScreen() {
  const navigation = useNavigation<any>();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['orders', 'qaQueue'],
    queryFn: () => listOrders(QA_STATUSES),
  });

  const rows = data ?? [];

  return (
    <Screen padded={false}>
      <Text style={styles.lede}>
        {rows.length === 0
          ? 'Nothing waiting on you.'
          : `${rows.length} order${rows.length === 1 ? '' : 's'} waiting on you. Each one opens straight into Start QA — pass or reject every piece.`}
      </Text>

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
              <Text style={styles.emptyBody}>No orders are waiting on you.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <QueueRow
              order={item}
              // Always the same destination. Which step it opens on is the
              // order's business, decided inside the screen from its status.
              onPress={() => navigation.navigate('OrderQa', { orderId: item.id })}
            />
          )}
        />
      )}
    </Screen>
  );
}

function QueueRow({ order, onPress }: { order: OrderListRow; onPress: () => void }) {
  // One label for both statuses. Splitting it named a difference the Inspector
  // no longer has to act on.
  const action = 'Start QA';
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
        <Text style={styles.mono}>{order.repeat_total}</Text> repeat
        {order.repeat_total === 1 ? '' : 's'} to inspect
      </Text>
      <Text style={styles.action}>{action} →</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  lede: {
    padding: spacing.lg,
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
