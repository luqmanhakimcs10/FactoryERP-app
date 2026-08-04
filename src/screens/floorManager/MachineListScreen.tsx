/**
 * Floor Manager — machine assignment list.
 *
 * Shows machines managed by this floor manager. Tap to assign a worker and order,
 * or view an already-open shift.
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
import { listMachines } from '../../api/endpoints/shifts';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import { colors, spacing, fontSize, fontWeight } from '../../constants/theme';

export function MachineListScreen() {
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['machines'],
    queryFn: listMachines,
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
  const openCount = rows.filter((m) => m.has_open_shift).length;

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(m) => m.id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.summary}>
              {openCount} open shift{openCount === 1 ? '' : 's'} · {rows.length} machine
              {rows.length === 1 ? '' : 's'}
            </Text>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? (
              <Text style={styles.error}>{describeDbError(error, 'Machine')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No machines</Text>
              <Text style={styles.emptyBody}>
                Machines assigned to you appear here for worker assignment.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ListRow
            monoTitle
            title={item.name}
            subtitle={
              item.has_open_shift
                ? `${item.worker_name ?? 'Worker'} · ${item.order_code ?? 'No order'}`
                : 'Available — tap to assign'
            }
            pillLabel={item.has_open_shift ? 'Open' : undefined}
            pillColor={item.has_open_shift ? colors.primary : undefined}
            onPress={() =>
              navigation.navigate('OpenShift', {
                machineId: item.id,
                machineName: item.name,
                openShiftId: item.open_shift_id,
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
  summary: { fontSize: fontSize.secondary, color: colors.slate },
  error: { fontSize: fontSize.secondary, color: colors.alert },
  disabled: { fontSize: fontSize.body, color: colors.slate, textAlign: 'center' },
  empty: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
