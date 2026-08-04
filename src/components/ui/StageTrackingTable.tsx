/**
 * Repeats & Stage Tracking (Stage 9) — shared between Floor Manager and QA.
 *
 * Both roles see the same table and the same current status per repeat.
 * "Start stage"/"Go to QA" are Floor-Manager-only; "Pass QA"/"Mark damage" are
 * QA-only (per the spec's explicit grouping for this loop — a deliberate
 * divergence from the shared Collection-QA gating elsewhere in the app).
 * "History" is available to both.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { AppButton } from './AppButton';
import { RepeatStatusPill } from './StatusPill';
import { SelectField } from '../forms/SelectField';
import { TextField } from '../forms/TextField';
import { PhotoPicker, type LocalPhoto } from '../camera/PhotoPicker';
import {
  listRepeatHistory,
  sendToStageQa,
  passStageQa,
  markStageDamage,
} from '../../api/endpoints/orders';
import { handOverStage, confirmCollection } from '../../api/endpoints/stageHandover';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { useNextStep, NEXT_STEP } from './NextStepToast';
import { describeDbError } from '../../utils/errors';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import type { Repeat, OrderStage, DamageType } from '../../models/orderTypes';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

const DAMAGE_OPTIONS: { value: DamageType; label: string }[] = (
  Object.keys(DAMAGE_TYPE_LABEL) as DamageType[]
).map((v) => ({ value: v, label: DAMAGE_TYPE_LABEL[v] }));

function stageNameForIndex(stages: OrderStage[], index: number): string | null {
  const s = stages.find((st) => st.sequence === index);
  return s ? s.stage_type.replace(/_/g, ' ') : null;
}

interface Props {
  orderId: string;
  factoryId: string | null | undefined;
  repeats: Repeat[];
  stages: OrderStage[];
}

export function StageTrackingTable({ orderId, factoryId, repeats, stages }: Props) {
  const { role } = useAuth();
  const queryClient = useQueryClient();
  const showNextStep = useNextStep();
  const isFloorManager = role === 'floor_manager' || role === 'company_admin';
  const isQa = role === 'qa' || role === 'company_admin';

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [damageId, setDamageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['repeats', orderId] });
    queryClient.invalidateQueries({ queryKey: ['timeline', orderId] });
    queryClient.invalidateQueries({ queryKey: ['damage', orderId] });
  }

  // "Start stage" is gone (0056): a stage opens at In Progress on its own, both
  // for the first stage (Start Production) and for every stage after it (the
  // Floor Manager's collection confirmation). Two new Floor Manager actions
  // replace it at the far ends of the cycle.
  const handOverMutation = useMutation({
    mutationFn: (id: string) => handOverStage(id),
    onMutate: (id) => { setMutatingId(id); setError(null); },
    onSuccess: invalidate,
    onError: (e) => setError(describeDbError(e, 'Hand over')),
    onSettled: () => setMutatingId(null),
  });
  const collectMutation = useMutation({
    mutationFn: (id: string) => confirmCollection(id),
    onMutate: (id) => { setMutatingId(id); setError(null); },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['pendingCollections', orderId] });
    },
    onError: (e) => setError(describeDbError(e, 'Collect')),
    onSettled: () => setMutatingId(null),
  });
  const sendQaMutation = useMutation({
    mutationFn: (id: string) => sendToStageQa(id),
    onMutate: (id) => { setMutatingId(id); setError(null); },
    onSuccess: invalidate,
    onError: (e) => setError(describeDbError(e, 'Stage tracking')),
    onSettled: () => setMutatingId(null),
  });
  const passQaMutation = useMutation({
    mutationFn: (id: string) => passStageQa(id),
    onMutate: (id) => { setMutatingId(id); setError(null); },
    onSuccess: () => {
      invalidate();
      // Since 0056 a Stage QA pass ALWAYS lands on handover_for_delivery — the
      // last-stage special case moved to fm_confirm_collection, at the far end
      // of the delivery round trip. The row's next action ("Hand over") is now
      // the guidance, so no toast fires here.
    },
    onError: (e) => setError(describeDbError(e, 'Stage tracking')),
    onSettled: () => setMutatingId(null),
  });

  const rows = [...repeats].sort((a, b) => a.repeat_code.localeCompare(b.repeat_code));

  return (
    <View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.table}>
        <View style={styles.headRow}>
          <Text style={[styles.th, styles.colCode]}>Repeat</Text>
          <Text style={[styles.th, styles.colStatus]}>Status</Text>
          <Text style={[styles.th, styles.colActions]}>Actions</Text>
        </View>
        {rows.map((r) => {
          const stageName = stageNameForIndex(stages, r.current_stage_index);
          const busy = mutatingId === r.id;
          return (
            <View key={r.id}>
              <View style={styles.row}>
                <Text style={[styles.td, styles.mono, styles.colCode]}>{r.repeat_code}</Text>
                <View style={styles.colStatus}>
                  <RepeatStatusPill status={r.current_status} detail={stageName} />
                </View>
                <View style={[styles.colActions, styles.actionsWrap]}>
                  <Pressable
                    onPress={() => setHistoryId(historyId === r.id ? null : r.id)}
                    accessibilityRole="button"
                    style={styles.historyBtn}
                  >
                    <Text style={styles.historyText}>History</Text>
                  </Pressable>

                  {isFloorManager && r.current_status === 'handover_for_delivery' ? (
                    <AppButton
                      title="Hand over"
                      variant="brass"
                      loading={busy && handOverMutation.isPending}
                      disabled={busy && !handOverMutation.isPending}
                      onPress={() => handOverMutation.mutate(r.id)}
                      style={styles.actionBtn}
                    />
                  ) : null}
                  {isFloorManager && r.current_status === 'awaiting_fm_collection' ? (
                    <AppButton
                      title={`Collect ${stageName ?? 'stage'}`}
                      variant="brass"
                      loading={busy && collectMutation.isPending}
                      disabled={busy && !collectMutation.isPending}
                      onPress={() => collectMutation.mutate(r.id)}
                      style={styles.actionBtn}
                    />
                  ) : null}
                  {isFloorManager && r.current_status === 'in_progress' ? (
                    <AppButton
                      title="Go to QA"
                      variant="secondary"
                      loading={busy && sendQaMutation.isPending}
                      disabled={busy && !sendQaMutation.isPending}
                      onPress={() => sendQaMutation.mutate(r.id)}
                      style={styles.actionBtn}
                    />
                  ) : null}
                  {isQa && r.current_status === 'stage_qa' ? (
                    <AppButton
                      title="Pass QA"
                      variant="brass"
                      loading={busy && passQaMutation.isPending}
                      disabled={busy && !passQaMutation.isPending}
                      onPress={() => passQaMutation.mutate(r.id)}
                      style={styles.actionBtn}
                    />
                  ) : null}
                  {isQa && r.current_status !== 'damaged' && r.current_status !== 'completed' ? (
                    <AppButton
                      title="Mark damage"
                      variant="alert"
                      onPress={() => setDamageId(damageId === r.id ? null : r.id)}
                      style={styles.actionBtn}
                    />
                  ) : null}
                </View>
              </View>

              {historyId === r.id ? <HistoryPanel repeatId={r.id} /> : null}
              {damageId === r.id ? (
                <MarkDamagePanel
                  repeat={r}
                  orderId={orderId}
                  factoryId={factoryId}
                  onDone={() => {
                    setDamageId(null);
                    invalidate();
                  }}
                  onCancel={() => setDamageId(null)}
                />
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function HistoryPanel({ repeatId }: { repeatId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['repeatHistory', repeatId],
    queryFn: () => listRepeatHistory(repeatId),
  });
  return (
    <View style={styles.historyPanel}>
      {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
      {(data ?? []).map((h) => (
        <View key={h.id} style={styles.historyRow}>
          <Text style={styles.historyStatus}>{h.status.replace(/_/g, ' ')}</Text>
          <Text style={styles.historyMeta}>
            {new Date(h.created_at).toLocaleString()}
            {h.order_stages ? ` · ${h.order_stages.stage_type}` : ''}
            {h.profiles?.display_name ? ` · ${h.profiles.display_name}` : ''}
          </Text>
          {h.note ? <Text style={styles.historyMeta}>{h.note}</Text> : null}
        </View>
      ))}
      {!isLoading && !(data ?? []).length ? <Text style={styles.historyMeta}>No history yet.</Text> : null}
    </View>
  );
}

function MarkDamagePanel({
  repeat,
  orderId,
  factoryId,
  onDone,
  onCancel,
}: {
  repeat: Repeat;
  orderId: string;
  factoryId: string | null | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [damageType, setDamageType] = useState<DamageType>('fabric');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      let photoUrl: string | null = null;
      if (photo[0] && factoryId) {
        photoUrl = await uploadOrderPhoto(factoryId, orderId, photo[0].uri, 'stage-damage');
      }
      await markStageDamage(repeat.id, damageType, photoUrl, note.trim() || null);
      onDone();
    } catch (e) {
      setError(describeDbError(e, 'Mark damage'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.damagePanel}>
      <SelectField
        label="Damage reason"
        value={damageType}
        options={DAMAGE_OPTIONS}
        onChange={(v) => setDamageType((v as DamageType) ?? 'fabric')}
      />
      <PhotoPicker label="Photo (optional)" photos={photo} onChange={setPhoto} multiple={false} />
      <TextField label="Notes" value={note} onChangeText={setNote} multiline placeholder="Optional" />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.damageActions}>
        <AppButton title="Cancel" variant="secondary" onPress={onCancel} disabled={busy} style={{ flex: 1 }} />
        <AppButton title="Confirm damage" variant="alert" onPress={submit} loading={busy} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  headRow: { flexDirection: 'row', backgroundColor: colors.indigo, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  th: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  td: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  mono: { fontFamily: fontFamily.mono },
  colCode: { flex: 1.2 },
  colStatus: { flex: 1.4 },
  colActions: { flex: 2 },
  actionsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, justifyContent: 'flex-end' },
  actionBtn: { minHeight: 34, paddingHorizontal: spacing.sm },
  historyBtn: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  historyText: { fontSize: fontSize.caption, color: colors.indigo, fontWeight: fontWeight.medium },
  historyPanel: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.canvas,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  historyRow: { marginBottom: spacing.xs },
  historyStatus: { fontSize: fontSize.secondary, fontWeight: fontWeight.medium, color: colors.indigoDeep, textTransform: 'capitalize' },
  historyMeta: { fontSize: fontSize.caption, color: colors.slate },
  damagePanel: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.canvas,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  damageActions: { flexDirection: 'row', gap: spacing.md },
});
