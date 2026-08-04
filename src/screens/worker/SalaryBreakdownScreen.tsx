/**
 * Salary Breakdown — shift-by-shift earnings for a payroll period.
 *
 * The worker picks a period (current and the two before it) and sees every
 * ledger entry: stitches, base pay, bonus, damage deduction, loan installment,
 * net and finalization status. Totals roll up at the top so the current-period
 * headline on the dashboard is auditable.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { StatusPill } from '../../components/ui/StatusPill';
import { getWorkerLedgerEntries } from '../../api/endpoints/dashboards';
import type { WorkerLedgerEntry } from '../../models/shiftTypes';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

/** YYYY-MM for the month n months before now (UTC). */
function periodFor(monthsBack: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const PERIODS = [periodFor(0), periodFor(1), periodFor(2)];

export function SalaryBreakdownScreen() {
  const [period, setPeriod] = useState(PERIODS[0]);

  const q = useQuery({
    queryKey: ['worker', 'ledgerEntries', period],
    queryFn: () => getWorkerLedgerEntries(period),
  });

  const totals = useMemo(() => {
    const rows = q.data ?? [];
    return {
      stitches: rows.reduce((s, r) => s + r.stitch_count, 0),
      base: rows.reduce((s, r) => s + r.stitch_count * r.base_per_stitch, 0),
      bonus: rows.reduce((s, r) => s + r.bonus, 0),
      damage: rows.reduce((s, r) => s + r.damage_deduction, 0),
      loan: rows.reduce((s, r) => s + r.loan_installment, 0),
      net: rows.reduce((s, r) => s + r.net, 0),
      finalized: rows.filter((r) => r.status === 'finalized').length === rows.length,
    };
  }, [q.data]);

  return (
    <Screen padded={false}>
      <View style={styles.periods}>
        {PERIODS.map((p) => (
          <Pressable
            key={p}
            onPress={() => setPeriod(p)}
            accessibilityRole="radio"
            accessibilityState={{ checked: period === p, selected: period === p }}
            {...(Platform.OS === 'web' ? ({ 'aria-checked': period === p } as object) : {})}
            style={({ pressed }) => [
              styles.period,
              period === p && styles.periodOn,
              pressed && { opacity: 0.75 },
            ]}
          >
            <Text style={[styles.periodText, period === p && styles.periodTextOn]}>{p}</Text>
          </Pressable>
        ))}
      </View>

      {q.isLoading ? (
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      ) : q.isError ? (
        <Text style={styles.error}>{describeDbError(q.error, 'Salary')}</Text>
      ) : (
        <FlatList
          data={q.data ?? []}
          keyExtractor={(r) => r.id}
          refreshControl={
            <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
          }
          ListHeaderComponent={
            <View style={styles.summary}>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Period {period}</Text>
                <StatusPill
                  label={totals.finalized ? 'Finalized' : 'Pending'}
                  color={totals.finalized ? colors.success : colors.warning}
                />
              </View>
              <Text style={styles.hero}>{Number(totals.net).toLocaleString()}</Text>
              <Text style={styles.summaryMeta}>
                <Text style={styles.mono}>{totals.stitches}</Text> stitches · base{' '}
                <Text style={styles.mono}>{Number(totals.base).toLocaleString()}</Text> · bonus{' '}
                <Text style={styles.mono}>{Number(totals.bonus).toLocaleString()}</Text>
                {totals.damage > 0 ? (
                  <>
                    {' · damage '}
                    <Text style={styles.mono}>{Number(totals.damage).toLocaleString()}</Text>
                  </>
                ) : null}
                {totals.loan > 0 ? (
                  <>
                    {' · loan '}
                    <Text style={styles.mono}>{Number(totals.loan).toLocaleString()}</Text>
                  </>
                ) : null}
              </Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No shifts in {period}</Text>
              <Text style={styles.emptyBody}>
                Ledger entries appear here once the floor manager closes your shifts.
              </Text>
            </View>
          }
          renderItem={({ item }) => <EntryRow row={item} />}
        />
      )}
    </Screen>
  );
}

function EntryRow({ row }: { row: WorkerLedgerEntry }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Text style={styles.rowTitle}>{new Date(row.created_at).toLocaleDateString()}</Text>
        <StatusPill
          label={row.status === 'finalized' ? 'Finalized' : 'Pending'}
          color={row.status === 'finalized' ? colors.success : colors.warning}
        />
      </View>
      <Text style={styles.meta}>
        <Text style={styles.mono}>{row.stitch_count}</Text> stitches @{' '}
        <Text style={styles.mono}>{row.base_per_stitch}</Text> ={' '}
        <Text style={styles.mono}>{Number(row.stitch_count * row.base_per_stitch).toLocaleString()}</Text>
      </Text>
      <Text style={styles.meta}>
        bonus <Text style={styles.mono}>{Number(row.bonus).toLocaleString()}</Text>
        {row.damage_deduction > 0 ? (
          <>
            {' · damage '}
            <Text style={styles.mono}>{Number(row.damage_deduction).toLocaleString()}</Text>
          </>
        ) : null}
        {row.loan_installment > 0 ? (
          <>
            {' · loan '}
            <Text style={styles.mono}>{Number(row.loan_installment).toLocaleString()}</Text>
          </>
        ) : null}
      </Text>
      <Text style={styles.net}>
        Net <Text style={styles.mono}>{Number(row.net).toLocaleString()}</Text>
        {row.payment_proof_url ? ' · proof attached' : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  periods: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.lg },
  period: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  periodOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  periodText: { fontSize: fontSize.caption, color: colors.slate, fontWeight: fontWeight.medium },
  periodTextOn: { color: colors.white },
  summary: {
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.xs,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  summaryLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  summaryMeta: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  hero: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
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
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  net: { marginTop: spacing.xs, fontSize: fontSize.secondary, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  error: { padding: spacing.lg, fontSize: fontSize.secondary, color: colors.alert },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
