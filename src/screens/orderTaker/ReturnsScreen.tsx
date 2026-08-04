/**
 * Returns — where the Order Taker's repeats stand in the finishing cycle.
 *
 * Mostly read-only: every production transition behind the data it shows
 * (handoff, return, collection QA, final delivery) is an RPC that asserts
 * delivery/QA/floor-manager role, so an order taker calling one is refused by
 * the database. The one exception is "Complete return" on the Active returns
 * tab — a physical event only the order taker witnesses (the piece has gone
 * back to the vendor), backed by `ot_complete_return` (0036) for a finishing
 * return and `ot_complete_qa_return` (0054) for an Initial-QA rejection.
 * Neither touches the underlying production state machine.
 *
 * Two kinds of thing physically go back to the vendor, and both belong here
 * (0054): a finishing-stage return, and a piece rejected at Initial QA. The
 * second used to be invisible — the board was built on handoff history, which
 * a rejected piece never has — so Active returns read (0) while rejected
 * pieces waited. Rows carry `kind`; the button dispatches on it.
 *
 * Three tabs, defined by the data rather than by this screen (see 0032/0036/0054):
 *   Active returns    — out at a finishing stage and not yet confirmed back, or
 *                        rejected at Initial QA and not yet confirmed back.
 *   Completed returns — came back and passed collection QA, or the order taker
 *                        has confirmed the physical handback.
 *   Handover          — final delivery to the client. ORDER-LEVEL, because
 *                        Phase 6 records delivery on the order and there is no
 *                        per-repeat handover row to read; the repeat counts
 *                        are shown so this tab still reconciles against the
 *                        other two.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Image,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { StatusPill } from '../../components/ui/StatusPill';
import { AppButton } from '../../components/ui/AppButton';
import {
  listReturnRepeats,
  listHandoverOrders,
  completeReturnEntry,
  type ReturnRepeatRow,
} from '../../api/endpoints/orders';
import { getPhotoUrls, uploadOrderPhoto } from '../../api/endpoints/storage';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import type { DamageType } from '../../models/orderTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

type Tab = 'active' | 'completed' | 'handover';

const TABS: { key: Tab; label: string }[] = [
  { key: 'active', label: 'Active returns' },
  { key: 'completed', label: 'Completed returns' },
  { key: 'handover', label: 'Handover' },
];

/**
 * This board words statuses from the ORDER TAKER's point of view — "where is my
 * client's piece?" — which is why it does not reuse RepeatStatusPill's floor
 * wording. The 0056 handover statuses are included so a piece mid-round-trip
 * reads as a sentence rather than falling through to a raw column value.
 */
const REPEAT_STATUS_LABEL: Record<string, string> = {
  ready_for_production: 'Ready for next stage',
  in_progress: 'Being worked on',
  stage_qa: 'At stage QA',
  handover_for_delivery: 'Ready to go out',
  awaiting_dp_collection: 'Awaiting pickup',
  handed_over: 'With the delivery person',
  in_production: 'In production',
  in_finishing: 'In finishing',
  handed_off: 'Out at partner',
  returned_to_delivery: 'Collected from partner',
  awaiting_fm_collection: 'Back at the factory',
  awaiting_collection_qa: 'Back — awaiting QA',
  awaiting_final_qa: 'Awaiting final QA',
  awaiting_qa_final: 'With QA — final pass',
  completed: 'Completed',
  rejected_at_qa: 'Rejected at Initial QA',
};

function statusPill(row: ReturnRepeatRow) {
  const label = REPEAT_STATUS_LABEL[row.current_status] ?? row.current_status.replace(/_/g, ' ');
  if (row.sla_breached) return { label: `${label} · SLA`, color: colors.alert };
  switch (row.current_status) {
    case 'rejected_at_qa':
      return { label, color: colors.alert };
    case 'handed_off':
      return { label, color: colors.warning };
    case 'awaiting_collection_qa':
      return { label, color: colors.indigo };
    case 'awaiting_dp_collection':
    case 'handed_over':
      return { label, color: colors.warning };
    case 'awaiting_fm_collection':
      return { label, color: colors.brass };
    case 'completed':
    case 'awaiting_final_qa':
    case 'awaiting_qa_final':
      return { label, color: colors.success };
    default:
      return { label, color: colors.brass };
  }
}

const when = (v: string | null) => (v ? new Date(v).toLocaleDateString() : '—');

/** What this piece is and why it's here, in one line. */
function describeReason(row: ReturnRepeatRow): string | null {
  if (!row.reason) return null;
  return DAMAGE_TYPE_LABEL[row.reason as DamageType] ?? row.reason.replace(/_/g, ' ');
}

export function ReturnsScreen() {
  const { role, enabledModules, profile } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.ORDER_LIFECYCLE, enabledModules, role);
  const [tab, setTab] = useState<Tab>('active');
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const repeats = useQuery({
    queryKey: ['returnRepeats'],
    queryFn: listReturnRepeats,
    enabled: moduleOn,
  });
  const handover = useQuery({
    queryKey: ['handoverOrders'],
    queryFn: listHandoverOrders,
    enabled: moduleOn && tab === 'handover',
  });

  // The bucket is private, so every photo needs its own signed URL. One batched
  // call for the whole board rather than one per row.
  const photoPaths = (repeats.data ?? []).map((r) => r.photo_url).filter(Boolean) as string[];
  const { data: photoUrls } = useQuery({
    queryKey: ['returnPhotos', photoPaths.join(',')],
    queryFn: () => getPhotoUrls(photoPaths),
    enabled: moduleOn && photoPaths.length > 0,
  });

  // Completing a return now needs proof that the piece physically went back to
  // the vendor (0057), so the button opens a capture step instead of firing the
  // mutation directly. `capturingId` is which row is mid-capture.
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [returnPhoto, setReturnPhoto] = useState<LocalPhoto[]>([]);

  const completeMutation = useMutation({
    mutationFn: async (row: ReturnRepeatRow) => {
      if (!returnPhoto[0]) throw new Error('Take a photo of the piece first.');
      const url = await uploadOrderPhoto(
        profile?.factory_id ?? '',
        row.order_id,
        returnPhoto[0].uri,
        'vendor-return'
      );
      return completeReturnEntry(row, url);
    },
    onMutate: (row: ReturnRepeatRow) => {
      setCompletingId(row.entry_id);
      setCompleteError(null);
    },
    onSuccess: () => {
      setCapturingId(null);
      setReturnPhoto([]);
      queryClient.invalidateQueries({ queryKey: ['returnRepeats'] });
    },
    onError: (e) => setCompleteError(describeDbError(e, 'Returns')),
    onSettled: () => setCompletingId(null),
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const rows = (repeats.data ?? []).filter((r) => r.bucket === tab);
  const q = tab === 'handover' ? handover : repeats;
  const counts = {
    active: (repeats.data ?? []).filter((r) => r.bucket === 'active').length,
    completed: (repeats.data ?? []).filter((r) => r.bucket === 'completed').length,
  };

  const tabs = (
    <View style={styles.tabs}>
      {TABS.map((t) => {
        const on = tab === t.key;
        const badge =
          t.key === 'active' ? counts.active : t.key === 'completed' ? counts.completed : null;
        return (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, selected: on }}
            {...(Platform.OS === 'web' ? ({ 'aria-checked': on } as object) : {})}
            style={({ pressed }) => [styles.tab, on && styles.tabOn, pressed && { opacity: 0.75 }]}
          >
            <Text style={[styles.tabText, on && styles.tabTextOn]}>
              {t.label}
              {badge != null && repeats.data ? ` (${badge})` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  const header = (
    <View>
      {tabs}
      {q.isLoading ? <ActivityIndicator color={colors.indigo} style={{ margin: spacing.lg }} /> : null}
      {q.isError ? <Text style={styles.error}>{describeDbError(q.error, 'Returns')}</Text> : null}
      {completeError ? <Text style={styles.error}>{completeError}</Text> : null}
      <Text style={styles.note}>
        {tab === 'active'
          ? 'Pieces rejected at Initial QA, and repeats out at a finishing stage or back waiting on QA. Once a piece has physically gone back to the vendor, press "Complete return".'
          : tab === 'completed'
          ? 'Repeats that returned and passed collection QA, or that you confirmed had gone back to the vendor.'
          : 'Final delivery is recorded per order, so this tab lists orders with their repeat counts.'}
      </Text>
    </View>
  );

  if (tab === 'handover') {
    const orders = handover.data ?? [];
    return (
      <Screen padded={false}>
        <FlatList
          data={orders}
          keyExtractor={(o) => o.order_id}
          refreshControl={
            <RefreshControl
              refreshing={handover.isRefetching}
              onRefresh={handover.refetch}
              tintColor={colors.indigo}
            />
          }
          ListHeaderComponent={header}
          ListEmptyComponent={
            !handover.isLoading ? (
              <Text style={styles.empty}>
                No order of yours has reached delivery handover yet.
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.code}>{item.order_code ?? '(draft)'}</Text>
                <StatusPill
                  label={item.bucket === 'delivered' ? 'Delivered' : 'Ready for handover'}
                  color={item.bucket === 'delivered' ? colors.success : colors.brass}
                />
              </View>
              <Text style={styles.line}>{item.vendor_name}</Text>
              <Text style={styles.meta}>
                <Text style={styles.mono}>{item.ready_repeats}</Text> of{' '}
                <Text style={styles.mono}>{item.total_repeats}</Text> repeats cleared final QA
              </Text>
              <Text style={styles.meta}>
                {item.bucket === 'delivered'
                  ? `Delivered ${when(item.delivered_at)}${item.has_proof ? ' · photo' : ''}${
                      item.has_signature ? ' · signature' : ''
                    }`
                  : 'Waiting on the delivery person'}
              </Text>
            </View>
          )}
        />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.entry_id}
        refreshControl={
          <RefreshControl
            refreshing={repeats.isRefetching}
            onRefresh={repeats.refetch}
            tintColor={colors.indigo}
          />
        }
        ListHeaderComponent={header}
        ListEmptyComponent={
          !repeats.isLoading ? (
            <Text style={styles.empty}>
              {tab === 'active'
                ? 'Nothing of yours is out at a finishing stage or rejected at QA right now.'
                : 'No repeat of yours has come back through collection QA yet.'}
            </Text>
          ) : null
        }
        renderItem={({ item }) => {
          const pill = statusPill(item);
          const reason = describeReason(item);
          const photo = item.photo_url ? photoUrls?.[item.photo_url] : undefined;
          return (
            <View style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.code}>{item.repeat_code}</Text>
                <StatusPill label={pill.label} color={pill.color} />
              </View>
              <Text style={styles.line}>
                {item.vendor_name}
                {item.order_code ? ` · ${item.order_code}` : ''}
              </Text>
              <Text style={styles.meta}>
                Sheet {item.sheet_number} · {item.color_assignment}
                {item.piece_index && item.piece_total
                  ? ` · piece ${item.piece_index} of ${item.piece_total}`
                  : ''}
                {item.kind === 'finishing' && item.stage_type
                  ? ` · ${item.stage_type.replace(/_/g, ' ')}`
                  : ''}
                {item.partner_name ? ` · ${item.partner_name}` : ''}
              </Text>
              {reason ? (
                <Text style={styles.meta}>
                  Reason: <Text style={styles.reason}>{reason}</Text>
                  {item.note ? ` — ${item.note}` : ''}
                </Text>
              ) : null}
              <Text style={styles.meta}>
                {item.bucket === 'active'
                  ? item.kind === 'qa_rejection'
                    ? `Rejected at Initial QA ${when(item.occurred_at)}`
                    : `Handed off ${when(item.handed_off_at)}${
                        item.returned_at ? ` · returned ${when(item.returned_at)}` : ''
                      }`
                  : item.ot_return_confirmed_at
                  ? `Return confirmed ${when(item.ot_return_confirmed_at)}`
                  : `Returned ${when(item.returned_at)} · ${item.stages_returned} stage${
                      item.stages_returned === 1 ? '' : 's'
                    } cleared`}
              </Text>
              {photo ? (
                <Image
                  source={{ uri: photo }}
                  style={styles.photo}
                  accessibilityLabel={`Photo for ${item.repeat_code}`}
                />
              ) : item.photo_url ? (
                <Text style={styles.meta}>Photo on file</Text>
              ) : null}
              {item.bucket === 'active' && capturingId !== item.entry_id ? (
                <AppButton
                  title="Complete return"
                  variant="secondary"
                  disabled={completeMutation.isPending}
                  onPress={() => {
                    setCompleteError(null);
                    setReturnPhoto([]);
                    setCapturingId(item.entry_id);
                  }}
                  style={styles.completeButton}
                />
              ) : null}

              {capturingId === item.entry_id ? (
                <View style={styles.captureBox}>
                  <PhotoPicker
                    label="Photo of the piece handed back to the vendor"
                    hint="Required — this is the proof the return actually happened."
                    photos={returnPhoto}
                    onChange={setReturnPhoto}
                    multiple={false}
                    retakeLabel="Retake"
                  />
                  <View style={styles.captureActions}>
                    <AppButton
                      title="Cancel"
                      variant="secondary"
                      onPress={() => {
                        setCapturingId(null);
                        setReturnPhoto([]);
                        setCompleteError(null);
                      }}
                      disabled={completeMutation.isPending}
                      style={{ flex: 1 }}
                    />
                    <AppButton
                      title="Confirm return"
                      variant="brass"
                      loading={completingId === item.entry_id}
                      disabled={!returnPhoto[0]}
                      onPress={() => completeMutation.mutate(item)}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  tab: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  tabText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    fontWeight: fontWeight.medium,
  },
  tabTextOn: { color: colors.white, fontWeight: fontWeight.semibold },
  note: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    fontSize: fontSize.caption,
    color: colors.slate,
    lineHeight: 18,
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
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.indigoDeep,
    fontWeight: fontWeight.medium,
    flexShrink: 1,
  },
  line: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  reason: { color: colors.alert, fontWeight: fontWeight.medium },
  photo: {
    marginTop: spacing.sm,
    width: 88,
    height: 88,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  completeButton: { marginTop: spacing.sm, alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: spacing.lg },
  captureBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  captureActions: { flexDirection: 'row', gap: spacing.sm },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  empty: {
    padding: spacing.xl,
    fontSize: fontSize.secondary,
    color: colors.slate,
    textAlign: 'center',
  },
  error: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.alert,
  },
  disabled: {
    padding: spacing.xl,
    fontSize: fontSize.body,
    color: colors.slate,
    textAlign: 'center',
  },
});

export default ReturnsScreen;
