/**
 * Approvals Inbox — one queue, three kinds of decision.
 *
 * This screen is where several "pending" states from earlier phases actually
 * resolve. In particular, approving a worker-accountable damage record is the
 * mechanism Phase 5 promised but did not build: it writes the deduction into
 * that worker's OPEN ledger period. Rejecting leaves pay untouched and marks the
 * record resolved so it stops coming back.
 *
 * Deductions can only land in an open period, so approving late never reaches
 * back into pay that has already been run.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { StatCard } from '../../components/ui/StatGrid';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import {
  getApprovalsQueue,
  approveExpense,
  approveDamage,
  decideSlabProposal,
  getDamageRecord,
  type ApprovalRow,
} from '../../api/endpoints/finance';
import { getPhotoUrl } from '../../api/endpoints/storage';
import { describeDbError } from '../../utils/errors';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

const KIND_LABEL: Record<string, string> = {
  expense: 'Expense',
  damage: 'Damage',
  bonus_slab: 'Bonus slab',
};
const KIND_COLOR: Record<string, string> = {
  expense: colors.warning,
  damage: colors.alert,
  bonus_slab: colors.indigo,
};
/** Accountability tag colours, consistent app-wide since Phase 3. */
const RESPONSIBLE_COLOR: Record<string, string> = {
  vendor: colors.accountVendor,
  worker: colors.accountWorker,
  partner: colors.accountPartner,
};

export function ApprovalsInboxScreen() {
  const navigation = useNavigation<any>();
  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['approvals'],
    queryFn: getApprovalsQueue,
  });

  const rows = data ?? [];
  const byKind = (k: string) => rows.filter((r) => r.kind === k).length;

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(r) => `${r.kind}-${r.id}`}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.counters}>
              <StatCard label="Expenses" value={String(byKind('expense'))} icon="cash-outline" />
              <StatCard
                label="Damage"
                value={String(byKind('damage'))}
                icon="alert-circle-outline"
                tone="attention"
              />
              <StatCard label="Bonus slabs" value={String(byKind('bonus_slab'))} icon="trophy-outline" />
            </View>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? <Text style={styles.emptyBody}>{describeDbError(error, 'Approvals')}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>Nothing to approve</Text>
              <Text style={styles.emptyBody}>
                Expenses, damage deductions and bonus slab changes land here.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ApprovalRowView
            row={item}
            onPress={() => navigation.navigate('ApprovalDetail', { kind: item.kind, id: item.id })}
          />
        )}
      />
    </Screen>
  );
}

function ApprovalRowView({ row, onPress }: { row: ApprovalRow; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowTop}>
        <StatusPill label={KIND_LABEL[row.kind] ?? row.kind} color={KIND_COLOR[row.kind] ?? colors.slate} />
        {row.amount != null && Number(row.amount) > 0 ? (
          <Text style={styles.amount}>{Number(row.amount).toLocaleString()}</Text>
        ) : null}
      </View>
      <Text style={styles.title}>{row.title}</Text>
      {row.subtitle ? <Text style={styles.meta} numberOfLines={2}>{row.subtitle}</Text> : null}
      <Text style={styles.action}>Review →</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
export function ApprovalDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const kind: string = route.params?.kind;
  const id: string = route.params?.id;

  const [deduction, setDeduction] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const { data: damage } = useQuery({
    queryKey: ['damageRecord', id],
    queryFn: () => getDamageRecord(id),
    enabled: kind === 'damage',
  });
  const { data: photoUrl } = useQuery({
    queryKey: ['damagePhoto', damage?.photo_url],
    queryFn: () => getPhotoUrl(damage!.photo_url as string),
    enabled: !!damage?.photo_url,
  });

  React.useEffect(() => {
    if (damage && !deduction) setDeduction(String(damage.deduction ?? 0));
  }, [damage]);

  function invalidate() {
    for (const k of ['approvals', 'expenses', 'damageRecord', 'workerLedger', 'bonusSlabs', 'reportPl']) {
      queryClient.invalidateQueries({ queryKey: [k] });
    }
  }

  const decide = useMutation({
    mutationFn: async (approve: boolean) => {
      if (kind === 'expense') return approveExpense(id, approve, note.trim() || null);
      if (kind === 'damage') {
        return approveDamage(id, approve, deduction.trim() ? Number(deduction) : null);
      }
      return decideSlabProposal(id, approve);
    },
    onSuccess: (res: any) => {
      invalidate();
      if (kind === 'damage') {
        setOutcome(
          res?.approval_status === 'rejected'
            ? 'Rejected — no deduction was applied and pay is untouched.'
            : res?.posted
              ? `Approved — ${Number(res.deduction_applied).toLocaleString()} added to the ${res.responsible_type}'s ledger for ${res.period}.`
              : 'Approved — no payroll deduction applies to this accountable party.'
        );
      } else {
        setOutcome('Decision recorded.');
      }
    },
    onError: (e) => setError(describeDbError(e, 'Approval')),
  });

  const isDamage = kind === 'damage';

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <StatusPill label={KIND_LABEL[kind] ?? kind} color={KIND_COLOR[kind] ?? colors.slate} />

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {isDamage && damage ? (
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>
                {DAMAGE_TYPE_LABEL[damage.damage_type as keyof typeof DAMAGE_TYPE_LABEL] ?? damage.damage_type}
              </Text>
              <StatusPill
                label={`${damage.responsible_type} accountable`}
                color={RESPONSIBLE_COLOR[damage.responsible_type] ?? colors.slate}
              />
            </View>
            <Text style={styles.meta}>Stage: {String(damage.stage_type).replace(/_/g, ' ')}</Text>
            {damage.orders?.order_code ? (
              <Text style={styles.meta}>Order <Text style={styles.mono}>{damage.orders.order_code}</Text></Text>
            ) : null}
            {damage.repeats?.repeat_code ? (
              <Text style={styles.meta}>Repeat <Text style={styles.mono}>{damage.repeats.repeat_code}</Text></Text>
            ) : null}
            {damage.note ? <Text style={styles.meta}>{damage.note}</Text> : null}

            {photoUrl ? (
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              <View style={styles.photoWrap}>
                {React.createElement(require('react-native').Image, {
                  source: { uri: photoUrl },
                  style: styles.photo,
                  resizeMode: 'contain',
                })}
              </View>
            ) : null}

            {damage.responsible_type !== 'worker' ? (
              <Text style={styles.hint}>
                {damage.responsible_type === 'vendor'
                  ? 'Vendor-accountable — approving records the finding; it does not touch payroll.'
                  : 'Partner-accountable — approving posts a charge to the partner ledger, not payroll.'}
              </Text>
            ) : null}
          </View>
        ) : null}

        {outcome ? (
          <>
            <ActionBanner
              tone="neutral"
              title="Done"
              subtitle={outcome}
              style={styles.bannerGap}
            />
            <AppButton
              title="Back to inbox"
              variant="secondary"
              onPress={() => navigation.navigate('ApprovalsInbox')}
            />
          </>
        ) : (
          <>
            {isDamage ? (
              <TextField
                label="Deduction amount"
                value={deduction}
                onChangeText={setDeduction}
                placeholder="0"
                numeric
                mono
              />
            ) : (
              <TextField
                label="Note (optional)"
                value={note}
                onChangeText={setNote}
                placeholder="Reason for the decision"
                multiline
              />
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <AppButton
              title="Approve"
              onPress={() => { setError(null); decide.mutate(true); }}
              loading={decide.isPending}
            />
            <View style={{ height: spacing.md }} />
            <AppButton
              title="Reject"
              variant="secondary"
              onPress={() => { setError(null); decide.mutate(false); }}
              disabled={decide.isPending}
            />

            {isDamage ? (
              <Text style={styles.hint}>
                Approving adds this amount to the responsible party's ledger for
                the current open period. Rejecting leaves it at zero.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  counters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, padding: spacing.lg },
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
  title: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  amount: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  action: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.brass, fontWeight: fontWeight.semibold },
  stitch: { marginVertical: spacing.lg },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: 2,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.xs },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep, flexShrink: 1 },
  photoWrap: { marginTop: spacing.md },
  photo: { width: '100%', height: 220, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  hint: { marginTop: spacing.md, fontSize: fontSize.caption, color: colors.slate, lineHeight: 18, fontStyle: 'italic' },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1 },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { paddingHorizontal: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
