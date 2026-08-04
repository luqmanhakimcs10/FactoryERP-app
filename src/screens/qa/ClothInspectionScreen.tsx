/**
 * Incoming Cloth Inspection.
 *
 * Per cloth: Accept, or flag Damaged with a reason. A damage finding writes a
 * `damage_records` row with responsible_type='vendor' — the first of the three
 * accountability points (worker damage arrives in Phase 5, partner in Phase 6).
 *
 * Findings and acceptance are separate actions on purpose: QA may log several
 * damaged pieces and still accept the remainder of the consignment, which is how
 * a real inspection goes.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SelectField } from '../../components/forms/SelectField';
import { TextField } from '../../components/forms/TextField';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import {
  getOrder,
  listSheets,
  listOrderDamage,
  reportClothDamage,
  acceptCloth,
} from '../../api/endpoints/orders';
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

export function ClothInspectionScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const orderId: string = route.params?.orderId;

  const [mode, setMode] = useState<'idle' | 'damage'>('idle');
  const [damageType, setDamageType] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: order, isLoading } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId),
  });
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

  const acceptMutation = useMutation({
    mutationFn: () => acceptCloth(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['order', orderId] });
      // Straight on to piece-by-piece QA — that is the next thing QA must do.
      navigation.replace('OrderQa', { orderId });
    },
    onError: (e) => setFormError(describeDbError(e, 'Order')),
  });

  if (isLoading || !order) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const totalRepeats = (sheets ?? []).reduce((n, s) => n + s.repeats_count, 0);
  const busy = damageMutation.isPending || acceptMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.code}>{order.order_code}</Text>
        <Text style={styles.vendor}>{order.vendors?.name}</Text>
        <Text style={styles.meta}>
          {sheets?.length ?? 0} sheets · <Text style={styles.mono}>{totalRepeats}</Text> repeats
          expected
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* Existing findings */}
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
                {d.sheets ? (
                  <Text style={styles.cardLine}>
                    Sheet {d.sheets.sheet_number} · {d.sheets.color_assignment}
                  </Text>
                ) : (
                  <Text style={styles.cardLine}>Whole consignment</Text>
                )}
                {d.note ? <Text style={styles.cardLine}>{d.note}</Text> : null}
              </View>
            ))}
          </View>
        ) : null}

        {/* Damage entry */}
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
              label="Which sheet?"
              value={sheetId}
              options={(sheets ?? []).map((s) => ({
                value: s.id,
                label: `Sheet ${s.sheet_number} · ${s.color_assignment}`,
              }))}
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
              title="Accept cloth & continue to coding"
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
              Log every damaged piece first, then accept the consignment. Damage is
              recorded against the vendor and stays visible on the order.
            </Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.indigoDeep },
  meta: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  stitch: { marginVertical: spacing.lg },
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
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
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep, flexShrink: 1 },
  cardLine: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  actions: { flexDirection: 'row', gap: spacing.md },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  hint: { marginTop: spacing.md, fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
});
