/**
 * Floor Manager — shift close walk list.
 *
 * One machine at a time: tap an open shift to close it, then return here.
 */
import React from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ListRow } from '../../components/lists/ListRow';
import { listShiftCloseQueue } from '../../api/endpoints/shifts';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import { colors, spacing, fontSize, fontWeight } from '../../constants/theme';

function formatOpened(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function ShiftCloseQueueScreen() {
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['shiftCloseQueue'],
    queryFn: listShiftCloseQueue,
    enabled: moduleOn,
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const rows = data ?? [];

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.shift_id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.hint}>
              Close one machine at a time. Capture the panel photo, confirm the count, then
              return here for the next.
            </Text>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? (
              <Text style={styles.error}>{describeDbError(error, 'Shift')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>All shifts closed</Text>
              <Text style={styles.emptyBody}>
                Open shifts awaiting close appear here. Assign machines first if the floor is
                empty.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ListRow
            monoTitle
            title={item.machine_name}
            subtitle={`${item.worker_name}${item.order_code ? ` · ${item.order_code}` : ''} · ${formatOpened(item.opened_at)}`}
            pillLabel="Awaiting close"
            pillColor={colors.warning}
            onPress={() =>
              navigation.navigate('ShiftClose', {
                shiftId: item.shift_id,
                machineName: item.machine_name,
              })
            }
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { padding: spacing.lg, gap: spacing.sm },
  hint: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 22 },
  error: { fontSize: fontSize.secondary, color: colors.alert },
  disabled: { fontSize: fontSize.body, color: colors.slate, textAlign: 'center' },
  empty: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
