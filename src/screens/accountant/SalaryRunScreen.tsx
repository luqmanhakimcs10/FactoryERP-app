/**
 * Accountant — salary run summary for the current payroll period.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { ListRow } from '../../components/lists/ListRow';
import { finalizeSalaryRun, salaryRunSummary } from '../../api/endpoints/shifts';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  fontFamily,
  radius,
} from '../../constants/theme';

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const SALARY_TYPE_LABEL: Record<string, string> = {
  per_stitch: 'Per stitch',
  per_day: 'Per day',
  per_month: 'Per month',
};

export function SalaryRunScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ finalized_count: number; period: string } | null>(null);

  const { data, isLoading, isError, error: qError, refetch, isRefetching } = useQuery({
    queryKey: ['salaryRun'],
    queryFn: () => salaryRunSummary(),
    enabled: moduleOn,
  });

  const finalizeMutation = useMutation({
    mutationFn: () => finalizeSalaryRun(),
    onSuccess: (r) => {
      setResult(r);
      queryClient.invalidateQueries({ queryKey: ['salaryRun'] });
    },
    onError: (e) => setError(describeDbError(e, 'Salary run')),
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const rows = data ?? [];
  const pendingWorkers = rows.filter((r) => r.has_pending);
  const period = rows[0]?.worker_name ? new Date().toISOString().slice(0, 7) : null;
  const totalNet = rows.reduce((s, r) => s + Number(r.total_net), 0);

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.worker_id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.period}>Period {period ?? '—'}</Text>
            <View style={styles.totals}>
              <Text style={styles.totalLabel}>Total net pay</Text>
              <Text style={styles.totalValue}>{money(totalNet)}</Text>
            </View>
            {result ? (
              <ActionBanner
                tone="neutral"
                title={`Finalized ${result.finalized_count} entr${result.finalized_count === 1 ? 'y' : 'ies'} for ${result.period}`}
                style={styles.bannerGap}
              />
            ) : null}
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? (
              <Text style={styles.error}>{describeDbError(qError, 'Salary run')}</Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {pendingWorkers.length > 0 ? (
              <AppButton
                title={`Generate salary run (${pendingWorkers.length} worker${pendingWorkers.length === 1 ? '' : 's'})`}
                onPress={() => finalizeMutation.mutate()}
                loading={finalizeMutation.isPending}
                variant="brass"
                style={{ marginTop: spacing.md }}
              />
            ) : rows.length > 0 ? (
              <Text style={styles.allFinal}>All entries finalized for this period.</Text>
            ) : null}
            {rows.length > 0 ? (
              <Text style={styles.section}>Workers</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No ledger entries</Text>
              <Text style={styles.emptyBody}>
                Shift closes post pending entries here. Close shifts on the floor first.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const typeLabel = item.salary_type ? SALARY_TYPE_LABEL[item.salary_type] : null;
          const detail = typeLabel
            ? `${typeLabel} · ${
                item.salary_type === 'per_month' || item.salary_type === 'per_day'
                  ? `Net ${money(Number(item.total_net))}`
                  : `${item.total_stitches.toLocaleString()} st · Net ${money(Number(item.total_net))}`
              }`
            : `${item.total_stitches.toLocaleString()} st · Net ${money(Number(item.total_net))}`;
          return (
            <ListRow
              title={item.worker_name}
              subtitle={detail}
              pillLabel={item.has_pending ? 'Pending' : 'Finalized'}
              pillColor={item.has_pending ? colors.warning : colors.success}
              onPress={() =>
                navigation.navigate('WorkerLedger', {
                  workerId: item.worker_id,
                  workerName: item.worker_name,
                })
              }
            />
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  header: { padding: spacing.lg, gap: spacing.sm },
  period: { fontSize: fontSize.caption, color: colors.slate, textTransform: 'uppercase' },
  totals: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  totalLabel: { fontSize: fontSize.caption, color: colors.slate },
  totalValue: {
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    fontFamily: fontFamily.mono,
  },
  banner: {
    backgroundColor: colors.tintTeal,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  section: {
    marginTop: spacing.lg,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
  },
  error: { color: colors.alert, fontSize: fontSize.secondary },
  allFinal: { fontSize: fontSize.secondary, color: colors.success, marginTop: spacing.sm },
  disabled: { fontSize: fontSize.body, color: colors.slate, textAlign: 'center', padding: spacing.lg },
  empty: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
