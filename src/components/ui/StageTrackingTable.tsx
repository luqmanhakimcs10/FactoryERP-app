/**
 * Repeats & Stage Tracking (Stage 9) — shared between Floor Manager and QA.
 *
 * Both roles see the same table and the same current status per repeat.
 * "Go to QA", "Handover to …" and "Collect …" are Floor-Manager-only; "Pass QA"
 * and "Mark damage" are QA-only (per the spec's explicit grouping for this loop
 * — a deliberate divergence from the shared Collection-QA gating elsewhere in
 * the app). "History" is available to both.
 *
 * TWO CHANGES FROM 0084 LIVE HERE
 * -------------------------------
 * 1. Pass QA requires a photo, the same way Initial QA and the final pass do.
 *    It opens a panel rather than firing on tap, and the confirm inside it stays
 *    disabled until an image exists. The database refuses a passless photo too —
 *    this is the courtesy, not the rule.
 *
 * 2. "Hand over" is now named after where the piece is GOING — "Handover to
 *    Clipping" — read from the order's own stage sequence rather than hardcoded,
 *    and it opens one popup that captures the delivery person and the finishing
 *    partner together. Those two choices were previously made by two people at
 *    two different times, which is how a routing decision about an order ended
 *    up belonging to whoever picked the piece up.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import {
  handOverStage,
  confirmCollection,
  listDeliveryPeople,
} from '../../api/endpoints/stageHandover';
import { listLinkedOptions } from '../../api/endpoints/masters';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import type { Repeat, OrderStage, DamageType } from '../../models/orderTypes';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily, tint } from '../../constants/theme';

const DAMAGE_OPTIONS: { value: DamageType; label: string }[] = (
  Object.keys(DAMAGE_TYPE_LABEL) as DamageType[]
).map((v) => ({ value: v, label: DAMAGE_TYPE_LABEL[v] }));

/** "clipping" -> "Clipping"; "double_head" -> "Double head". */
function prettyStage(stage: string | null | undefined): string | null {
  if (!stage) return null;
  const words = stage.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function stageNameForIndex(stages: OrderStage[], index: number): string | null {
  const s = stages.find((st) => st.sequence === index);
  return s ? s.stage_type.replace(/_/g, ' ') : null;
}

/**
 * The stage a repeat would be handed over FOR — the one after the stage it has
 * just cleared. Null on the last stage, where `qa_pass_stage_qa` sends the piece
 * straight to Final QA and no handover exists to name.
 */
function nextStageOf(stages: OrderStage[], repeat: Repeat): OrderStage | null {
  return stages.find((st) => st.sequence === Math.max(repeat.current_stage_index, 1) + 1) ?? null;
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
  const isFloorManager = role === 'floor_manager' || role === 'company_admin';
  const isQa = role === 'qa' || role === 'company_admin';

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [damageId, setDamageId] = useState<string | null>(null);
  const [passQaId, setPassQaId] = useState<string | null>(null);
  const [handoverFor, setHandoverFor] = useState<Repeat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['repeats', orderId] });
    queryClient.invalidateQueries({ queryKey: ['timeline', orderId] });
    queryClient.invalidateQueries({ queryKey: ['damage', orderId] });
    queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
  }

  // "Start stage" is gone (0056): a stage opens on its own, both for the first
  // stage (Start Production) and for every stage after it (the Floor Manager's
  // collection confirmation, which since 0084 opens it at Stage QA because what
  // came back is a finishing partner's work and it has not been looked at yet).
  const collectMutation = useMutation({
    mutationFn: (id: string) => confirmCollection(id),
    onMutate: (id) => { setMutatingId(id); setError(null); },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['pendingCollections', orderId] });
      queryClient.invalidateQueries({ queryKey: ['pendingCollections'] });
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
          const nextStage = nextStageOf(stages, r);
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

                  {/* Named after the stage the piece is going TO, from this
                      order's own sequence. `qa_pass_stage_qa` only produces this
                      status when a next stage exists, so the fallback label is
                      defensive rather than expected. */}
                  {isFloorManager && r.current_status === 'handover_for_delivery' ? (
                    <AppButton
                      title={
                        nextStage
                          ? `Handover to ${prettyStage(nextStage.stage_type)}`
                          : 'Hand over'
                      }
                      variant="brass"
                      onPress={() => {
                        setError(null);
                        setHandoverFor(r);
                      }}
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
                      onPress={() => {
                        setError(null);
                        setPassQaId(passQaId === r.id ? null : r.id);
                      }}
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
              {passQaId === r.id ? (
                <PassQaPanel
                  repeat={r}
                  orderId={orderId}
                  factoryId={factoryId}
                  stageName={stageName}
                  nextStageName={prettyStage(nextStage?.stage_type)}
                  onDone={() => {
                    setPassQaId(null);
                    invalidate();
                  }}
                  onCancel={() => setPassQaId(null)}
                />
              ) : null}
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

      {handoverFor ? (
        <HandoverModal
          repeat={handoverFor}
          nextStage={nextStageOf(stages, handoverFor)}
          onClose={() => setHandoverFor(null)}
          onDone={() => {
            setHandoverFor(null);
            invalidate();
            queryClient.invalidateQueries({ queryKey: ['dpOrders'] });
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * Pass Stage QA — photo first. (0084, Fix 3)
 *
 * Same shape as Mark damage below, deliberately: both are QA recording a
 * judgement about a piece, and both should feel like filling in a record rather
 * than pressing a button. The confirm stays disabled until an image exists;
 * `qa_pass_stage_qa` refuses a passless photo as well, so this cannot be
 * side-stepped by a stale client.
 */
function PassQaPanel({
  repeat,
  orderId,
  factoryId,
  stageName,
  nextStageName,
  onDone,
  onCancel,
}: {
  repeat: Repeat;
  orderId: string;
  factoryId: string | null | undefined;
  stageName: string | null;
  nextStageName: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [photo, setPhoto] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      if (!photo[0]) throw new Error('Take a photo of the piece first.');
      if (!factoryId) throw new Error('No factory on your profile.');
      const url = await uploadOrderPhoto(factoryId, orderId, photo[0].uri, 'stage-qa');
      await passStageQa(repeat.id, url);
      onDone();
    } catch (e) {
      setError(describeDbError(e, 'Pass QA'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.damagePanel}>
      <PhotoPicker
        label={`Photo of ${repeat.repeat_code}${stageName ? ` after ${stageName}` : ''}`}
        hint="Required — this is the record of what was approved at this stage."
        photos={photo}
        onChange={setPhoto}
        multiple={false}
        retakeLabel="Retake"
      />
      <Text style={styles.panelNote}>
        {nextStageName
          ? `Passing releases this piece for handover to ${nextStageName}.`
          : 'This is the last stage — passing sends the piece straight to Final QA.'}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.damageActions}>
        <AppButton title="Cancel" variant="secondary" onPress={onCancel} disabled={busy} style={{ flex: 1 }} />
        <AppButton
          title="Pass QA"
          variant="brass"
          onPress={submit}
          loading={busy}
          disabled={!photo[0]}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

/**
 * One popup, both choices. (0084, Fix 4)
 *
 * Who carries the piece and who does the work on it are one decision made at one
 * moment by the person who owns the order. Splitting them — the Floor Manager
 * releasing the piece, the delivery person choosing the partner later — is what
 * put a routing decision about an order in the hands of whoever picked it up.
 *
 * Partners are filtered to those who actually do the destination stage. The
 * database enforces the same rule, so an empty list here means the factory has
 * no partner for that stage on file, not that the filter is wrong.
 */
function HandoverModal({
  repeat,
  nextStage,
  onClose,
  onDone,
}: {
  repeat: Repeat;
  nextStage: OrderStage | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stageLabel = prettyStage(nextStage?.stage_type) ?? 'the next stage';

  const { data: people, isLoading: peopleLoading } = useQuery({
    queryKey: ['deliveryPeople'],
    queryFn: listDeliveryPeople,
  });
  const { data: partners, isLoading: partnersLoading } = useQuery({
    queryKey: ['finishingPartnerOptions', nextStage?.stage_type ?? 'any'],
    queryFn: () =>
      listLinkedOptions(
        'finishing_partners',
        'name',
        nextStage ? { stage_type: nextStage.stage_type } : undefined
      ),
  });

  const submit = useMutation({
    mutationFn: () => handOverStage(repeat.id, deliveryId!, partnerId!),
    onSuccess: onDone,
    onError: (e) => setError(describeDbError(e, 'Hand over')),
  });

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalTitle}>Handover to {stageLabel}</Text>
            <Text style={styles.modalSub}>
              {repeat.repeat_code} leaves the floor for {stageLabel.toLowerCase()}. Choose who
              carries it and who does the work.
            </Text>

            <SelectField
              label="Delivery person"
              value={deliveryId}
              onChange={setDeliveryId}
              required
              loading={peopleLoading}
              options={(people ?? []).map((p) => ({ value: p.id, label: p.display_name }))}
              emptyHint="No active delivery people on file — add one under Employees."
            />

            <SelectField
              label={`${stageLabel} partner`}
              value={partnerId}
              onChange={setPartnerId}
              required
              loading={partnersLoading}
              options={partners ?? []}
              emptyHint={`No finishing partner handles ${stageLabel.toLowerCase()} yet — add one under Master data.`}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.damageActions}>
              <AppButton
                title="Cancel"
                variant="secondary"
                onPress={onClose}
                disabled={submit.isPending}
                style={{ flex: 1 }}
              />
              <AppButton
                title="Confirm handover"
                variant="brass"
                onPress={() => {
                  setError(null);
                  submit.mutate();
                }}
                loading={submit.isPending}
                disabled={!deliveryId || !partnerId}
                style={{ flex: 1 }}
              />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
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
  panelNote: {
    marginBottom: spacing.sm,
    fontSize: fontSize.caption,
    color: colors.slate,
    lineHeight: 18,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: tint(colors.indigoDeep, 0.45),
  },
  modalCard: {
    maxHeight: '85%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  modalBody: { padding: spacing.xl, paddingBottom: spacing.xxl },
  modalTitle: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  modalSub: {
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
    fontSize: fontSize.secondary,
    color: colors.slate,
    lineHeight: 20,
  },
});
