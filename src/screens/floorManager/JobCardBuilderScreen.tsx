/**
 * Floor Manager: Job Card Builder (Stage 3).
 *
 * Top-to-bottom: design-sheet photo → design details (design code, stitches
 * per repeat, auto-computed total) → stage sequence → a read-only preview of
 * the generated needle/colour lines. "Continue to review" saves everything
 * and hands off to JobCardReviewScreen, where the needle/colour mapping
 * actually becomes editable — this screen never edits a line directly.
 *
 * Generation only runs once (when no lines exist yet) so re-entering this
 * screen after Review edits never silently wipes a corrected mapping. If the
 * underlying sheets change later, "Regenerate lines" on the job card detail
 * screen is the deliberate, explicit escape hatch for that.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { SelectField } from '../../components/forms/SelectField';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import {
  getOrder,
  listSheets,
  listOrderStages,
  getJobCard,
  setStageSequence,
  generateJobCard,
  updateOrderPhotos,
  saveJobCardDesign,
} from '../../api/endpoints/orders';
import { listMasters } from '../../api/endpoints/masters';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import type { StageInput } from '../../models/orderTypes';
import type { StageType } from '../../models/types';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

const ALL_STAGES: { type: StageType; label: string }[] = [
  { type: 'embroidery', label: 'Embroidery' },
  { type: 'clipping', label: 'Clipping' },
  { type: 'press', label: 'Press' },
  { type: 'piko', label: 'Piko' },
];

interface StageDraft {
  stage_type: StageType;
  is_outsourced: boolean;
  sla_hours: string;
  partner_id: string | null;
}

export function JobCardBuilderScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const orderId: string = route.params?.orderId;

  const [designPhoto, setDesignPhoto] = useState<LocalPhoto[]>([]);
  const [designCode, setDesignCode] = useState('');
  const [stitchesPerRepeat, setStitchesPerRepeat] = useState('');
  const [stages, setStages] = useState<StageDraft[]>([]);
  const [addingStage, setAddingStage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  const { data: order, isLoading } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId),
  });
  const { data: sheets } = useQuery({
    queryKey: ['sheets', orderId],
    queryFn: () => listSheets(orderId),
  });
  const { data: existingStages } = useQuery({
    queryKey: ['orderStages', orderId],
    queryFn: () => listOrderStages(orderId),
  });
  const { data: jobCard } = useQuery({
    queryKey: ['jobCard', orderId],
    queryFn: () => getJobCard(orderId),
  });
  const { data: partners } = useQuery({
    queryKey: ['masters', 'finishing_partners', '', false],
    queryFn: () => listMasters({ table: 'finishing_partners', searchField: 'name' }),
  });

  // Seed from whatever already exists (revisiting the builder after Review, etc).
  useEffect(() => {
    if (seeded) return;
    if (existingStages === undefined || jobCard === undefined) return;
    if (existingStages.length) {
      setStages(
        existingStages.map((s) => ({
          stage_type: s.stage_type,
          is_outsourced: s.is_outsourced,
          sla_hours: String(s.sla_hours),
          partner_id: s.partner_id,
        }))
      );
    }
    if (jobCard.card?.design_code) setDesignCode(jobCard.card.design_code);
    if (jobCard.card?.stitches_per_repeat) {
      setStitchesPerRepeat(String(jobCard.card.stitches_per_repeat));
    }
    setSeeded(true);
  }, [existingStages, jobCard, seeded]);

  const continueMutation = useMutation({
    mutationFn: async () => {
      if (designPhoto[0] && profile?.factory_id) {
        const path = await uploadOrderPhoto(profile.factory_id, orderId, designPhoto[0].uri, 'design');
        await updateOrderPhotos(orderId, order?.cloth_photos ?? [], path);
      }
      await saveJobCardDesign(orderId, designCode.trim(), parseFloat(stitchesPerRepeat));
      const payload: StageInput[] = stages.map((s) => ({
        stage_type: s.stage_type,
        is_outsourced: s.is_outsourced,
        sla_hours: parseInt(s.sla_hours, 10) || 24,
        partner_id: s.is_outsourced ? s.partner_id : null,
      }));
      await setStageSequence(orderId, payload);
      if (!jobCard?.lines?.length) {
        await generateJobCard(orderId);
      }
    },
    onSuccess: () => {
      for (const k of ['order', 'orderStages', 'jobCard', 'repeats']) {
        queryClient.invalidateQueries({ queryKey: [k, orderId] });
      }
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      navigation.replace('JobCardReview', { orderId });
    },
    onError: (e: unknown) => setError(describeDbError(e, 'Job card')),
  });

  function addStage(type: StageType) {
    setStages((prev) => [...prev, { stage_type: type, is_outsourced: false, sla_hours: '24', partner_id: null }]);
    setAddingStage(false);
  }
  function removeStage(type: StageType) {
    setStages((prev) => prev.filter((s) => s.stage_type !== type));
  }
  function patch(i: number, p: Partial<StageDraft>) {
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...p } : s)));
  }

  if (isLoading || !order) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  // The order's total planned repeat count (from the sheets captured at order
  // time), not merely how many have been QA-coded so far — those can lag
  // behind on orders with rejected/returned pieces, which would otherwise make
  // this understate (or blank out) the total.
  const repeatCount = (sheets ?? []).reduce((sum, s) => sum + (s.repeats_count ?? 0), 0);
  const stitchesValue = parseFloat(stitchesPerRepeat);
  const totalStitches = !isNaN(stitchesValue) && repeatCount ? Math.round(stitchesValue * repeatCount) : null;
  const lines = jobCard?.lines ?? [];
  const availableStages = ALL_STAGES.filter((s) => !stages.some((x) => x.stage_type === s.type));
  const busy = continueMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>{order.vendors?.name}</Text>

        <PhotoPicker
          label="Design sheet"
          hint={
            order.design_sheet_url
              ? 'A design sheet is already attached; adding one replaces it.'
              : 'Attach the design sheet — camera or gallery.'
          }
          photos={designPhoto}
          onChange={setDesignPhoto}
          multiple={false}
          retakeLabel="↻ Retake photo"
        />

        <Section title="Design details">
          <View style={styles.row}>
            <View style={styles.rowField}>
              <TextField
                label="Design code"
                value={designCode}
                onChangeText={setDesignCode}
                placeholder="e.g. DS-4785"
                required
                mono
              />
            </View>
            <View style={styles.rowField}>
              <NumberStepperField
                label="Stitches per repeat"
                value={stitchesPerRepeat}
                onChangeText={setStitchesPerRepeat}
                required
              />
            </View>
            <View style={styles.rowField}>
              <Text style={styles.label}>Total stitches</Text>
              <View style={styles.totalBox}>
                <Text style={styles.totalValue}>
                  {totalStitches !== null ? totalStitches.toLocaleString() : '—'}
                </Text>
              </View>
              <Text style={styles.totalRepeats}>{repeatCount} repeats</Text>
            </View>
          </View>
        </Section>

        <Section title="Stage sequence">
          <Text style={styles.label}>
            Stage sequence<Text style={styles.req}> *</Text>
          </Text>
          <View style={styles.tagRow}>
            {stages.map((s) => (
              <View key={s.stage_type} style={styles.tag}>
                <Text style={styles.tagText}>{ALL_STAGES.find((a) => a.type === s.stage_type)?.label ?? s.stage_type}</Text>
                <Pressable
                  onPress={() => removeStage(s.stage_type)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${s.stage_type}`}
                  hitSlop={6}
                >
                  <Ionicons name="close" size={14} color={colors.indigoDeep} />
                </Pressable>
              </View>
            ))}
            {availableStages.length ? (
              <Pressable
                onPress={() => setAddingStage((v) => !v)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.addTag, pressed && styles.pressed]}
              >
                <Text style={styles.addTagText}>+ Add stage</Text>
                <Ionicons name={addingStage ? 'chevron-up' : 'chevron-down'} size={14} color={colors.indigo} />
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.help}>Selection order becomes the processing sequence.</Text>

          {addingStage ? (
            <View style={styles.addOptions}>
              {availableStages.map((s) => (
                <Pressable
                  key={s.type}
                  onPress={() => addStage(s.type)}
                  style={({ pressed }) => [styles.addOption, pressed && styles.pressed]}
                >
                  <Text style={styles.addOptionText}>{s.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {stages.map((s, i) => (
            <View key={s.stage_type} style={styles.stageCard}>
              <Text style={styles.stageCardTitle}>
                {i + 1}. {s.stage_type}
              </Text>
              <SelectField
                label="Handled by"
                value={s.is_outsourced ? 'out' : 'in'}
                options={[
                  { value: 'in', label: 'In-house' },
                  { value: 'out', label: 'Outsourced' },
                ]}
                onChange={(v) => patch(i, { is_outsourced: v === 'out', partner_id: null })}
              />
              {s.is_outsourced ? (
                <SelectField
                  label="Finishing partner"
                  value={s.partner_id}
                  options={(partners ?? []).map((p: any) => ({
                    value: p.id,
                    label: `${p.name} (${String(p.stage_type)})`,
                  }))}
                  onChange={(v) => patch(i, { partner_id: v })}
                  allowClear
                  clearLabel="Decide later"
                  emptyHint="No finishing partners on file yet."
                />
              ) : null}
              <TextField
                label="SLA (hours)"
                value={s.sla_hours}
                onChangeText={(v) => patch(i, { sla_hours: v })}
                numeric
                mono
                placeholder="24"
              />
            </View>
          ))}
        </Section>

        <Section title="Needle & color lines">
          <Text style={styles.help}>
            Generated from the order's thread colours, numbered in order and capped at 6 — the most
            needles on any of your machines. You can correct, add or remove lines on the next screen.
          </Text>
          {lines.length ? (
            <View style={styles.table}>
              {lines
                .slice()
                .sort((a, b) => a.needle_number - b.needle_number)
                .map((l) => (
                  <View key={l.id} style={styles.previewRow}>
                    <Text style={[styles.previewNeedle, styles.mono]}>Needle {l.needle_number}</Text>
                    <Text style={[styles.previewColor, styles.mono]}>{l.thread_color_code}</Text>
                  </View>
                ))}
            </View>
          ) : (
            <Text style={styles.help}>
              Nothing generated yet — continue to see the lines and adjust them.
            </Text>
          )}
        </Section>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Continue to review"
          onPress={() => {
            setError(null);
            if (!designCode.trim()) {
              setError('A design code is required.');
              return;
            }
            const n = parseFloat(stitchesPerRepeat);
            if (!n || n <= 0) {
              setError('Stitches per repeat must be a positive number.');
              return;
            }
            if (!stages.length) {
              setError('Pick at least one stage.');
              return;
            }
            continueMutation.mutate();
          }}
          loading={busy}
          disabled={busy}
        />
      </ScrollView>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function NumberStepperField({
  label,
  value,
  onChangeText,
  required,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  required?: boolean;
}) {
  function step(delta: number) {
    const current = parseInt(value, 10) || 0;
    const next = Math.max(0, current + delta);
    onChangeText(String(next));
  }
  return (
    <View style={styles.stepperWrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.req}> *</Text> : null}
      </Text>
      <View style={styles.stepperField}>
        <TextField label="" value={value} onChangeText={onChangeText} numeric mono placeholder="0" />
        <View style={styles.stepperBtns}>
          <Pressable onPress={() => step(1)} accessibilityRole="button" hitSlop={4} style={styles.stepperBtn}>
            <Ionicons name="chevron-up" size={14} color={colors.indigo} />
          </Pressable>
          <Pressable onPress={() => step(-1)} accessibilityRole="button" hitSlop={4} style={styles.stepperBtn}>
            <Ionicons name="chevron-down" size={14} color={colors.indigo} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { marginTop: spacing.xs, marginBottom: spacing.lg, fontSize: fontSize.body, color: colors.indigoDeep },
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  help: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.md, lineHeight: 20 },
  label: { fontSize: fontSize.secondary, fontWeight: fontWeight.medium, color: colors.indigoDeep, marginBottom: spacing.sm },
  req: { color: colors.alert },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.lg },
  rowField: { flex: 1, minWidth: 140 },
  totalBox: {
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.canvas,
    paddingHorizontal: spacing.md,
  },
  totalRepeats: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.slate },
  totalValue: { fontSize: fontSize.body, fontFamily: fontFamily.mono, color: colors.slate },
  stepperWrap: { marginBottom: 0 },
  stepperField: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  stepperBtns: { marginTop: spacing.xs, gap: 2 },
  stepperBtn: {
    width: 28,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tagText: { fontSize: fontSize.secondary, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  addTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.indigo,
  },
  addTagText: { fontSize: fontSize.secondary, color: colors.indigo, fontWeight: fontWeight.medium },
  addOptions: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  addOption: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  addOptionText: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  stageCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  stageCardTitle: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    textTransform: 'capitalize',
    marginBottom: spacing.md,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.canvas,
  },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  previewNeedle: { fontSize: fontSize.secondary, color: colors.slate },
  previewColor: { fontSize: fontSize.secondary, color: colors.slate },
  mono: { fontFamily: fontFamily.mono },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  pressed: { opacity: 0.75 },
});
