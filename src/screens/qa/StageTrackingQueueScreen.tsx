/**
 * QA — Repeats & Stage Tracking queue (Stage 9).
 *
 * `InspectionQueueScreen` is QA's only other navigation entry point, and it
 * deliberately lists just `awaiting_cloth_inspection`/`awaiting_coding` orders
 * — once an order moves into production it drops off that list, and QA had no
 * other route to reach it. Without this screen, QA could never actually reach
 * `StageTracking` (Pass QA / Mark damage) for any order past the coding
 * stage — the exact access the spec requires QA to have.
 */
import React from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ListRow } from '../../components/lists/ListRow';
import { listOrders } from '../../api/endpoints/orders';
import { describeDbError } from '../../utils/errors';
import { colors, spacing } from '../../constants/theme';

const STAGE_TRACKING_STATUSES = ['in_production', 'in_finishing'] as const;

export function StageTrackingQueueScreen() {
  const navigation = useNavigation<any>();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['orders', 'qaStageTracking'],
    queryFn: () => listOrders([...STAGE_TRACKING_STATUSES]),
  });

  return (
    <Screen padded={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(o) => o.id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          isLoading ? <ActivityIndicator color={colors.indigo} style={{ margin: spacing.lg }} /> : null
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>Nothing in production</Text>
              <Text style={styles.emptyBody}>
                {isError
                  ? describeDbError(error, 'Order')
                  : 'Orders appear here once the floor manager starts production.'}
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ListRow
            monoTitle
            title={item.order_code ?? '(draft)'}
            subtitle={item.vendor_name}
            onPress={() => navigation.navigate('StageTracking', { orderId: item.id })}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.indigoDeep },
  emptyBody: { fontSize: 14, color: colors.slate, textAlign: 'center' },
});

export default StageTrackingQueueScreen;
