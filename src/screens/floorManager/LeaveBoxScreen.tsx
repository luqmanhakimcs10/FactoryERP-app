/**
 * Leave box — Floor Manager.
 *
 * Every worker leave request in the factory, filterable by status. Approve/
 * Reject only shows for pending rows — see fm_decide_leave (migration 0035),
 * which validates a leave hasn't already been decided before flipping it.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SelectField } from '../../components/forms/SelectField';
import { StatusPill } from '../../components/ui/StatusPill';
import { listFactoryLeaves, decideLeave } from '../../api/endpoints/shifts';
import { describeDbError } from '../../utils/errors';
import type { LeaveRow, LeaveStatus } from '../../models/shiftTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
} from '../../constants/theme';

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const STATUS_COLOR: Record<LeaveStatus, string> = {
  pending: colors.warning,
  approved: colors.success,
  rejected: colors.alert,
};

export function LeaveBoxScreen() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [error, setError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['factoryLeaves', status],
    queryFn: () => listFactoryLeaves(status),
  });

  const decideMutation = useMutation({
    mutationFn: (args: { leaveId: string; approve: boolean }) => decideLeave(args.leaveId, args.approve),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['factoryLeaves'] });
      queryClient.invalidateQueries({ queryKey: ['floorManagerCardCounts'] });
      setDecidingId(null);
    },
    onError: (e) => {
      setError(describeDbError(e, 'Leave request'));
      setDecidingId(null);
    },
  });

  return (
    <Screen padded={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(l) => l.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View>
            <SelectField label="Status" value={status} options={STATUS_OPTIONS} onChange={(v) => v && setStatus(v)} />
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={!isLoading ? <Text style={styles.emptyBody}>No leave requests here.</Text> : null}
        renderItem={({ item }) => (
          <LeaveCard
            leave={item}
            busy={decidingId === item.id && decideMutation.isPending}
            onDecide={(approve) => {
              setError(null);
              setDecidingId(item.id);
              decideMutation.mutate({ leaveId: item.id, approve });
            }}
          />
        )}
      />
    </Screen>
  );
}

function LeaveCard({
  leave,
  busy,
  onDecide,
}: {
  leave: LeaveRow;
  busy: boolean;
  onDecide: (approve: boolean) => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.name}>{leave.profiles?.display_name ?? '—'}</Text>
        <StatusPill label={leave.status} color={STATUS_COLOR[leave.status]} />
      </View>
      <Text style={styles.dates}>
        {leave.start_date} → {leave.end_date}
      </Text>
      <Text style={styles.reason}>{leave.reason}</Text>

      {leave.status === 'pending' ? (
        <View style={styles.actions}>
          <AppButton title="Approve" variant="primary" onPress={() => onDecide(true)} loading={busy} style={{ flex: 1 }} />
          <AppButton title="Reject" variant="alert" onPress={() => onDecide(false)} loading={busy} style={{ flex: 1 }} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 4,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  dates: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  reason: { fontSize: fontSize.secondary, color: colors.slate },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
});

export default LeaveBoxScreen;
