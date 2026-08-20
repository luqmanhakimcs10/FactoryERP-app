/**
 * Cloth inspection — now a STEP inside the one QA flow, not a screen of its own.
 *
 * It used to be `ClothInspectionScreen`, reached from its own bucket on the
 * inspection queue. That meant QA navigated between two destinations for one
 * order depending on which of two statuses it happened to be in, and the queue
 * carried two counters QA had to read before deciding where to tap. Both are
 * gone: an order has one QA flow, and this is its first step.
 *
 * The work itself is unchanged. Per consignment: log any damaged cloth (a
 * `damage_records` row, vendor-accountable), then accept — at which point the
 * order moves to `awaiting_coding` and the piece-by-piece list below unlocks in
 * place, with no navigation.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppButton } from '../../components/ui/AppButton';
import { SelectField } from '../../components/forms/SelectField';
import { TextField } from '../../components/forms/TextField';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { StatusPill } from '../../components/ui/StatusPill';
import { listSheets, listOrderDamage, reportClothDamage, acceptCloth } from '../../api/endpoints/orders';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
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

const DAMAGE_OPTIONS = Object.entries(DAMAGE_TYPE_LABEL).map(([value, label]) => ({
  value,
  label,
}));

export function ClothInspectionStep({ orderId }: { orderId: string }) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const [mode, setMode] = useState<'idle' | 'damage'>('idle');
  const [damageType, setDamageType] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: sheets } = useQuery({
    queryKey: ['sheets', orderId],
    queryFn: () => listSheets(orderId),
  });
  const { data: damage } = useQuery({
    queryKey: ['damage', orderId],
    queryFn: () => listOrderDamage(orderId),
  });

  const damageMutation = useMutation({
    mutationFn: async () => {
      if (!damageType) throw new Error('Choose a damage reason.');
      let photoPath: string | null = null;
      if (photos[0] && profile?.factory_id) {
        photoPath = await uploadOrderPhoto(profile.factory_id, orderId, photos[0].uri, 'damage');
      }
      return reportClothDamage({
        orderId,
        damageType,
        sheetId,
        photoUrl: photoPath,
        note: note.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['damage', orderId] });
      setMode('idle');
      setDamageType(null);
      setSheetId(null);
      setNote('');
      setPhotos([]);
    },
    onError: (e) => setFormError(describeDbError(e, 'Damage record')),
  });

  /**
   * Accepting does NOT navigate any more. The order flips to `awaiting_coding`
   * and this whole block disappears, revealing the piece list underneath — one
   * flow, one screen, which is the point of the consolidation.
   */
  const acceptMutation = useMutation({
    mutationFn: () => acceptCloth(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order', orderId] });
      queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
    },
    onError: (e) => setFormError(describeDbError(e, 'Order')),
  });

  const busy = damageMutation.isPending || acceptMutation.isPending;

  /**
   * A damage finding is filed against ONE cloth. Those are `sheets` rows, but
   * "sheet" is not a word this app shows the user any more, so each option is
   * named by its colour — with an index only when a colour has more than one,
   * which is the only case where the name alone is ambiguous.
   */
  const clothOptions = (sheets ?? []).map((s) => {
    const sameColor = (sheets ?? []).filter((o) => o.color_assignment === s.color_assignment);
    const suffix =
      sameColor.length > 1 ? ` (${sameColor.findIndex((o) => o.id === s.id) + 1} of ${sameColor.length})` : '';
    return {
      value: s.id,
      label: `${s.color_assignment}${suffix} · ${s.repeats_count} repeat${
        s.repeats_count === 1 ? '' : 's'
      }`,
    };
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.gate}>
        <Text style={styles.gateTitle}>Step 1 · Cloth inspection</Text>
        <Text style={styles.gateBody}>
          Check the consignment that arrived. Log every damaged cloth first, then accept — the
          piece-by-piece list below unlocks as soon as you do.
        </Text>
      </View>

      {damage?.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Findings so far ({damage.length})</Text>
          {damage.map((d) => (
            <View key={d.id} style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cardTitle}>
                  {DAMAGE_TYPE_LABEL[d.damage_type] ?? d.damage_type}
                </Text>
                <StatusPill label="Vendor accountable" color={colors.accountVendor} />
              </View>
              <Text style={styles.cardLine}>
                {d.sheets ? d.sheets.color_assignment : 'Whole consignment'}
              </Text>
              {d.note ? <Text style={styles.cardLine}>{d.note}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      {mode === 'damage' ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Record damaged cloth</Text>

          <SelectField
            label="Reason"
            value={damageType}
            options={DAMAGE_OPTIONS}
            onChange={setDamageType}
            required
          />

          <SelectField
            label="Which cloth?"
            value={sheetId}
            options={clothOptions}
            onChange={setSheetId}
            allowClear
            clearLabel="Whole consignment"
          />

          <TextField
            label="Note"
            value={note}
            onChangeText={setNote}
            placeholder="What exactly is wrong?"
            multiline
          />

          <PhotoPicker
            label="Photo proof"
            hint="Attach evidence — this record is chargeable to the vendor."
            photos={photos}
            onChange={setPhotos}
            multiple={false}
          />

          {formError ? <Text style={styles.error}>{formError}</Text> : null}

          <View style={styles.actions}>
            <AppButton
              title="Cancel"
              variant="secondary"
              onPress={() => {
                setMode('idle');
                setFormError(null);
              }}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <AppButton
              title="Save finding"
              onPress={() => {
                setFormError(null);
                if (!damageType) {
                  setFormError('Choose a damage reason.');
                  return;
                }
                damageMutation.mutate();
              }}
              loading={damageMutation.isPending}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      ) : (
        <View style={styles.section}>
          {formError ? <Text style={styles.error}>{formError}</Text> : null}

          <AppButton
            title="Accept cloth & start QA"
            onPress={() => {
              setFormError(null);
              acceptMutation.mutate();
            }}
            loading={acceptMutation.isPending}
            disabled={busy}
          />

          <View style={{ height: spacing.md }} />

          <AppButton
            title="Flag damaged cloth"
            variant="secondary"
            onPress={() => setMode('damage')}
            disabled={busy}
          />

          <Text style={styles.hint}>
            Damage is recorded against the vendor and stays visible on the order.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  gate: {
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.tintTeal,
    marginBottom: spacing.lg,
    gap: spacing.xs,
  },
  gateTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  gateBody: { fontSize: fontSize.secondary, color: colors.inkMuted, lineHeight: 20 },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitle: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
    flexShrink: 1,
  },
  cardLine: { marginTop: 2, fontSize: fontSize.caption, color: colors.inkMuted },
  actions: { flexDirection: 'row', gap: spacing.md },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  hint: { marginTop: spacing.md, fontSize: fontSize.caption, color: colors.inkMuted, lineHeight: 18 },
});

export default ClothInspectionStep;
