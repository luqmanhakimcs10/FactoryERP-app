/**
 * Material Requests — job cards confirmed by the vendor (Phase 3) that have not
 * yet had materials issued.
 *
 * Each row shows the same per-colour requirement/availability check
 * IssueDetailScreen already does (getJobCardRequirements — required vs
 * available, "sufficient" per colour), just inline for every order at once
 * instead of one at a time. When every colour is sufficient, "Ready — floor
 * manager will accept" issues the materials directly (issueMaterials /
 * sm_issue_materials — the same RPC, same stock_movements 'issue' log); that
 * material_issues row is what then shows up in the floor manager's Accept
 * Inventory tab. Tapping the row itself still opens IssueDetailScreen, for the
 * cases where a note is worth attaching before issuing.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { StatusPill } from '../../components/ui/StatusPill';
import {
  getMaterialIssueQueue,
  listMaterialIssues,
  listThreadStock,
  getJobCardRequirements,
  issueMaterials,
} from '../../api/endpoints/inventory';
import { describeDbError } from '../../utils/errors';
import type { MaterialIssueQueueRow, JobCardRequirement } from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Alert } = require('react-native');
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm', onPress: onConfirm },
  ]);
}

export function MaterialIssueQueueScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [issuingId, setIssuingId] = useState<string | null>(null);

  const { data: queue, isLoading, isError, error: queueError, refetch, isRefetching } = useQuery({
    queryKey: ['issueQueue'],
    queryFn: getMaterialIssueQueue,
  });
  const { data: issued } = useQuery({
    queryKey: ['materialIssues'],
    queryFn: listMaterialIssues,
  });
  const { data: threadStock } = useQuery({
    queryKey: ['threadStock', ''],
    queryFn: () => listThreadStock(),
  });
  const { data: requirementsByJobCard, isLoading: reqsLoading } = useQuery({
    queryKey: ['issueQueueRequirements', (queue ?? []).map((r) => r.job_card_id)],
    queryFn: async () => {
      const entries = await Promise.all(
        (queue ?? []).map(async (row) => [row.job_card_id, await getJobCardRequirements(row.job_card_id)] as const)
      );
      return Object.fromEntries(entries) as Record<string, JobCardRequirement[]>;
    },
    enabled: !!queue?.length,
  });

  const colorNames: Record<string, string> = {};
  for (const s of threadStock ?? []) {
    if (s.color_name) colorNames[s.color_code] = s.color_name;
  }

  const issueMutation = useMutation({
    mutationFn: (jobCardId: string) => issueMaterials(jobCardId, null),
    onSuccess: () => {
      for (const k of ['issueQueue', 'materialIssues', 'threadStock', 'stockLedger', 'issueQueueRequirements']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
      setIssuingId(null);
    },
    onError: (e) => {
      setError(describeDbError(e, 'Material issue'));
      setIssuingId(null);
    },
  });

  return (
    <Screen padded={false}>
      <FlatList
        data={queue ?? []}
        keyExtractor={(r) => r.job_card_id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            <Text style={styles.sectionTitle}>Material requests</Text>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? (
              <Text style={styles.emptyBody}>{describeDbError(queueError, 'Issue queue')}</Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>Nothing to issue</Text>
              <Text style={styles.emptyBody}>
                Job cards appear here once the vendor confirms them.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <RequestRow
            row={item}
            requirements={requirementsByJobCard?.[item.job_card_id]}
            loadingRequirements={reqsLoading}
            colorNames={colorNames}
            busy={issuingId === item.job_card_id && issueMutation.isPending}
            onPress={() =>
              navigation.navigate('IssueDetail', {
                jobCardId: item.job_card_id,
                orderCode: item.order_code,
              })
            }
            onReady={() => {
              setError(null);
              setIssuingId(item.job_card_id);
              confirmAction(
                'Issue materials',
                `${Number(item.total_meters).toLocaleString()} m across ${item.colors} colour(s) will be deducted from stock and logged against this job card.`,
                () => issueMutation.mutate(item.job_card_id)
              );
            }}
          />
        )}
        ListFooterComponent={
          issued?.length ? (
            <View style={styles.footer}>
              <Text style={styles.sectionTitle}>Recently issued</Text>
              {issued.slice(0, 10).map((mi) => (
                <View key={mi.id} style={styles.issuedRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.code}>{mi.issue_code}</Text>
                    <Text style={styles.meta}>
                      {mi.orders?.order_code ?? '—'} ·{' '}
                      {new Date(mi.issued_at).toLocaleDateString()}
                      {mi.accepted_at ? ' · accepted by floor manager' : ' · awaiting pickup'}
                    </Text>
                  </View>
                  <Text style={styles.mono}>
                    {(mi.material_issue_items ?? [])
                      .reduce((n, i) => n + Number(i.issued_meters), 0)
                      .toLocaleString()}{' '}
                    m
                  </Text>
                </View>
              ))}
            </View>
          ) : null
        }
      />
    </Screen>
  );
}

function RequestRow({
  row,
  requirements,
  loadingRequirements,
  colorNames,
  busy,
  onPress,
  onReady,
}: {
  row: MaterialIssueQueueRow;
  requirements: JobCardRequirement[] | undefined;
  loadingRequirements: boolean;
  colorNames: Record<string, string>;
  busy: boolean;
  onPress: () => void;
  onReady: () => void;
}) {
  const ok = !!requirements?.length && requirements.every((r) => r.sufficient);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.rowTop}>
        <Text style={styles.code}>{row.order_code}</Text>
        {requirements ? (
          <StatusPill label={ok ? 'OK' : 'Insufficient'} color={ok ? colors.success : colors.alert} />
        ) : null}
      </View>
      <Text style={styles.vendor} numberOfLines={1}>
        {row.vendor_name}
      </Text>

      {loadingRequirements && !requirements ? (
        <ActivityIndicator color={colors.indigo} style={{ alignSelf: 'flex-start', marginTop: spacing.xs }} />
      ) : (
        <View style={styles.pills}>
          {(requirements ?? []).map((r) => (
            <View
              key={r.color_code}
              style={[styles.pill, { backgroundColor: r.sufficient ? colors.tintTeal : colors.tintCoral }]}
            >
              <Text style={[styles.pillText, !r.sufficient && { color: colors.alert }]}>
                {colorNames[r.color_code] ?? r.color_code}: {Math.round(Number(r.available_meters))}/
                {Math.round(Number(r.required_meters))}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.actionRow}>
        {ok ? (
          <AppButton
            title="Ready — floor manager will accept"
            variant="brass"
            onPress={(e?: any) => {
              e?.stopPropagation?.();
              onReady();
            }}
            loading={busy}
            style={styles.readyBtn}
          />
        ) : requirements ? (
          <Text style={styles.notReady}>Not ready — insufficient stock for one or more colours</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  vendor: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, fontSize: fontSize.secondary, color: colors.indigoDeep },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 2 },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
  pillText: { fontSize: fontSize.caption, fontFamily: fontFamily.mono, color: colors.indigoDeep },
  actionRow: { marginTop: spacing.xs },
  readyBtn: { alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: spacing.md },
  notReady: { fontSize: fontSize.caption, color: colors.alert, fontStyle: 'italic' },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { paddingHorizontal: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
  error: { paddingHorizontal: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
  footer: { marginTop: spacing.xl, borderTopWidth: 1, borderTopColor: colors.border },
  issuedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
});

export default MaterialIssueQueueScreen;
