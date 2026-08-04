/**
 * Leave Request — a worker requests time off and tracks approvals.
 *
 * One of only two write paths in Phase 8 (the other is downtime). The submit
 * RPC is restricted to the worker role; the floor manager approves from their
 * own queue. Dates are entered as YYYY-MM-DD — validation is local so a bad
 * date never reaches the database.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { TextField } from '../../components/forms/TextField';
import { AppButton } from '../../components/ui/AppButton';
import { StatusPill } from '../../components/ui/StatusPill';
import { getWorkerLeaveHistory, submitWorkerLeave } from '../../api/endpoints/dashboards';
import type { LeaveRecord } from '../../models/dashboardTypes';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LEAVE_STATUS_COLOR: Record<LeaveRecord['status'], string> = {
  pending: colors.warning,
  approved: colors.success,
  rejected: colors.alert,
};

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function LeaveRequestScreen() {
  const queryClient = useQueryClient();

  const [reason, setReason] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ['worker', 'leaveHistory'],
    queryFn: getWorkerLeaveHistory,
  });

  const startOk = isValidDate(startDate);
  const endOk = isValidDate(endDate);
  const rangeOk = startOk && endOk && startDate <= endDate;
  const canSubmit = !submitting && reason.trim().length > 0 && rangeOk;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitWorkerLeave({ reason: reason.trim(), startDate, endDate });
      setReason('');
      setStartDate('');
      setEndDate('');
      history.refetch();
    } catch (e) {
      setError(describeDbError(e, 'Leave request'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList
          data={history.data ?? []}
          keyExtractor={(l) => l.id}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={history.isRefetching}
              onRefresh={history.refetch}
              tintColor={colors.indigo}
            />
          }
          ListHeaderComponent={
            <View style={styles.form}>
              <TextField
                label="Reason"
                value={reason}
                onChangeText={setReason}
                placeholder="e.g. medical appointment, family event"
                multiline
                required
              />
              <View style={styles.dates}>
                <View style={styles.dateField}>
                  <TextField
                    label="Start date (YYYY-MM-DD)"
                    value={startDate}
                    onChangeText={setStartDate}
                    placeholder="2026-08-10"
                    required
                    mono
                    error={
                      startDate.length > 0 && !startOk
                        ? 'Use YYYY-MM-DD'
                        : startOk && endOk && startDate > endDate
                          ? 'Start after end'
                          : undefined
                    }
                  />
                </View>
                <View style={styles.dateField}>
                  <TextField
                    label="End date (YYYY-MM-DD)"
                    value={endDate}
                    onChangeText={setEndDate}
                    placeholder="2026-08-10"
                    required
                    mono
                    error={endDate.length > 0 && !endOk ? 'Use YYYY-MM-DD' : undefined}
                  />
                </View>
              </View>

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <AppButton
                title={submitting ? 'Submitting…' : 'Submit request'}
                onPress={submit}
                loading={submitting}
                disabled={!canSubmit}
              />

              <Text style={styles.sectionLabel}>Previous requests</Text>
              {history.isLoading ? (
                <ActivityIndicator color={colors.indigo} />
              ) : history.isError ? (
                <Text style={styles.error}>{describeDbError(history.error, 'Leave')}</Text>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            history.isLoading || history.isError ? null : (
              <Text style={styles.empty}>No leave requests yet.</Text>
            )
          }
          renderItem={({ item }) => <LeaveRow row={item} />}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

function LeaveRow({ row }: { row: LeaveRecord }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Text style={styles.rowTitle}>
          {row.start_date} → {row.end_date}
        </Text>
        <StatusPill label={row.status} color={LEAVE_STATUS_COLOR[row.status]} />
      </View>
      <Text style={styles.rowBody}>{row.reason}</Text>
      <Text style={styles.rowMeta}>
        Requested {new Date(row.requested_at).toLocaleDateString()}
        {row.approved_at ? ` · decided ${new Date(row.approved_at).toLocaleDateString()}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { padding: spacing.xl, gap: 0 },
  dates: { flexDirection: 'row', gap: spacing.md },
  dateField: { flex: 1 },
  error: { marginBottom: spacing.lg, fontSize: fontSize.secondary, color: colors.alert },
  sectionLabel: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  empty: { padding: spacing.lg, fontSize: fontSize.secondary, color: colors.slate },
  row: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 2,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  rowTitle: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  rowBody: { fontSize: fontSize.secondary, color: colors.slate },
  rowMeta: { fontSize: fontSize.caption, color: colors.slate },
});
