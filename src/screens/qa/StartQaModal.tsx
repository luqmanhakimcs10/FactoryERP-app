/**
 * Start QA — the modal opened by a "Start QA" button on the Repeat QA tab.
 *
 * Sequence: Take photo (via PanelCamera, camera-first with a gallery fallback
 * — same component as shift close) -> Pass or Reject. Reject switches to a
 * detail form (damage reason, the same photo with a retake option, return
 * scope, notes) and submits a vendor-accountable damage record.
 *
 * One repeat is coded per Pass; a Reject never codes one — see qa_pass_piece /
 * qa_reject_piece in migration 0034.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Modal, Pressable, Image, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PanelCamera } from '../../components/camera/PanelCamera';
import { AppButton } from '../../components/ui/AppButton';
import { SelectField } from '../../components/forms/SelectField';
import { TextField } from '../../components/forms/TextField';
import { passRepeatPiece, rejectRepeatPiece, recheckRepeatPiece } from '../../api/endpoints/orders';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { describeDbError } from '../../utils/errors';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import type { DamageType, Order, Sheet } from '../../models/orderTypes';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';

const DAMAGE_OPTIONS = (Object.keys(DAMAGE_TYPE_LABEL) as DamageType[]).map((value) => ({
  value,
  label: DAMAGE_TYPE_LABEL[value],
}));

const RETURN_OPTIONS = [
  { value: 'piece', label: 'This piece only' },
  { value: 'sheet', label: 'Whole sheet' },
];

interface Props {
  visible: boolean;
  order: Order;
  sheet: Sheet;
  pieceIndex: number;
  pieceTotal: number;
  onClose: () => void;
  onResolved: () => void;
  /**
   * Set when this is a RE-inspection of a piece the vendor sent back (0059) —
   * the id of the damage record that rejected it. The screen is identical
   * (photo, then pass or reject with a reason), so the same modal serves both;
   * only the RPC underneath differs. Absent for a first inspection.
   */
  recheckDamageId?: string | null;
}

export function StartQaModal({
  visible,
  order,
  sheet,
  pieceIndex,
  pieceTotal,
  onClose,
  onResolved,
  recheckDamageId = null,
}: Props) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'capture' | 'reject'>('capture');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReturnStep, setCameraReturnStep] = useState<'capture' | 'reject'>('capture');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [damageType, setDamageType] = useState<DamageType>('fabric');
  const [returnScope, setReturnScope] = useState<'piece' | 'sheet'>('piece');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setStep('capture');
      setCameraOpen(false);
      setPhotoUri(null);
      setDamageType('fabric');
      setReturnScope('piece');
      setNote('');
      setError(null);
    }
  }, [visible]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['sheets', order.id] });
    queryClient.invalidateQueries({ queryKey: ['repeats', order.id] });
    queryClient.invalidateQueries({ queryKey: ['damage', order.id] });
    queryClient.invalidateQueries({ queryKey: ['order', order.id] });
  }

  const passMutation = useMutation({
    mutationFn: async () => {
      if (!photoUri) throw new Error('Take a photo first.');
      const path = await uploadOrderPhoto(order.factory_id, order.id, photoUri, 'qa-pass');
      if (recheckDamageId) {
        return recheckRepeatPiece({ damageId: recheckDamageId, pass: true, photoUrl: path });
      }
      return passRepeatPiece({ orderId: order.id, sheetId: sheet.id, photoUrl: path });
    },
    onSuccess: () => {
      invalidate();
      onResolved();
    },
    onError: (e) => setError(describeDbError(e, 'QA')),
  });

  const rejectMutation = useMutation({
    mutationFn: async () => {
      if (!photoUri) throw new Error('Take a photo first.');
      const path = await uploadOrderPhoto(order.factory_id, order.id, photoUri, 'qa-reject');
      if (recheckDamageId) {
        // A re-rejection is always about THIS one piece — the "whole sheet"
        // escalation only makes sense on a first inspection, where the rest of
        // the sheet has not been looked at yet.
        return recheckRepeatPiece({
          damageId: recheckDamageId,
          pass: false,
          photoUrl: path,
          damageType,
          note: note.trim() || null,
        });
      }
      return rejectRepeatPiece({
        orderId: order.id,
        sheetId: sheet.id,
        damageType,
        photoUrl: path,
        note: note.trim() || null,
        scope: returnScope,
      });
    },
    onSuccess: () => {
      invalidate();
      onResolved();
    },
    onError: (e) => setError(describeDbError(e, 'QA')),
  });

  const busy = passMutation.isPending || rejectMutation.isPending;

  function openCamera(returnTo: 'capture' | 'reject') {
    setCameraReturnStep(returnTo);
    setCameraOpen(true);
  }

  if (cameraOpen) {
    return (
      <Modal visible animationType="slide" onRequestClose={() => setCameraOpen(false)}>
        <PanelCamera
          hint="Frame the piece for QA inspection"
          onCapture={(uri) => {
            setPhotoUri(uri);
            setCameraOpen(false);
            setStep(cameraReturnStep);
          }}
          onCancel={() => setCameraOpen(false)}
        />
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            {recheckDamageId ? 'Re-inspect: ' : ''}
            {sheet.color_assignment} — piece {pieceIndex} of {pieceTotal}
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
            <Ionicons name="close" size={26} color={colors.indigoDeep} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {step === 'capture' ? (
            <>
              <Pressable
                onPress={() => openCamera('capture')}
                accessibilityRole="button"
                accessibilityLabel={photoUri ? 'Retake photo' : 'Take photo'}
                style={({ pressed }) => [styles.photoBox, pressed && styles.pressed]}
              >
                {photoUri ? (
                  <Image source={{ uri: photoUri }} style={styles.photoPreview} />
                ) : (
                  <>
                    <Ionicons name="camera" size={40} color={colors.white} />
                    <Text style={styles.photoBoxText}>Take photo</Text>
                  </>
                )}
              </Pressable>
              <Text style={styles.hint}>Tap to take a photo, or choose one from the gallery</Text>

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <View style={styles.decideRow}>
                <AppButton
                  title="Pass"
                  variant="primary"
                  onPress={() => {
                    setError(null);
                    passMutation.mutate();
                  }}
                  disabled={!photoUri || busy}
                  loading={passMutation.isPending}
                  style={{ flex: 1 }}
                />
                <AppButton
                  title="Reject"
                  variant="alert"
                  onPress={() => {
                    setError(null);
                    setStep('reject');
                  }}
                  disabled={!photoUri || busy}
                  style={{ flex: 1 }}
                />
              </View>
            </>
          ) : (
            <>
              <SelectField
                label="Damage reason"
                value={damageType}
                options={DAMAGE_OPTIONS}
                onChange={(v) => v && setDamageType(v as DamageType)}
              />

              <View style={styles.wrap}>
                <Text style={styles.label}>Photo</Text>
                <View style={styles.photoReview}>
                  <View>
                    {photoUri ? <Image source={{ uri: photoUri }} style={styles.photoThumb} /> : null}
                    <View style={styles.checkBadge}>
                      <Ionicons name="checkmark" size={12} color={colors.white} />
                    </View>
                  </View>
                  <Pressable onPress={() => openCamera('reject')} accessibilityRole="button">
                    <Text style={styles.retake}>Retake</Text>
                  </Pressable>
                </View>
              </View>

              {/* "Return the whole sheet" only makes sense on a FIRST
                  inspection, where the remaining pieces have not been looked at
                  yet. On a re-inspection this piece is the only one in hand. */}
              {recheckDamageId ? null : (
                <SelectField
                  label="Return"
                  value={returnScope}
                  options={RETURN_OPTIONS}
                  onChange={(v) => v && setReturnScope(v as 'piece' | 'sheet')}
                />
              )}

              <TextField
                label="Notes"
                placeholder="Optional details for the record"
                value={note}
                onChangeText={setNote}
                multiline
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <View style={styles.decideRow}>
                <AppButton
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setStep('capture')}
                  disabled={busy}
                  style={{ flex: 1 }}
                />
                <AppButton
                  title={rejectMutation.isPending ? 'Submitting...' : 'Confirm rejection'}
                  variant="alert"
                  onPress={() => {
                    setError(null);
                    rejectMutation.mutate();
                  }}
                  disabled={busy}
                  loading={rejectMutation.isPending}
                  style={{ flex: 1 }}
                />
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep, flexShrink: 1 },
  content: { padding: spacing.xl },
  photoBox: {
    height: 220,
    borderRadius: radius.lg,
    backgroundColor: colors.indigo,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    overflow: 'hidden',
  },
  photoPreview: { width: '100%', height: '100%' },
  photoBoxText: { color: colors.white, fontSize: fontSize.body, fontWeight: fontWeight.semibold },
  pressed: { opacity: 0.85 },
  hint: { marginTop: spacing.sm, textAlign: 'center', fontSize: fontSize.caption, color: colors.slate },
  decideRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  wrap: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.secondary, fontWeight: fontWeight.medium, color: colors.indigoDeep, marginBottom: spacing.sm },
  photoReview: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  photoThumb: { width: 64, height: 64, borderRadius: radius.md, borderWidth: 2, borderColor: colors.success },
  checkBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retake: { color: colors.indigo, fontSize: fontSize.secondary, fontWeight: fontWeight.semibold },
  error: { marginTop: spacing.md, color: colors.alert, fontSize: fontSize.secondary, textAlign: 'center' },
});

export default StartQaModal;
