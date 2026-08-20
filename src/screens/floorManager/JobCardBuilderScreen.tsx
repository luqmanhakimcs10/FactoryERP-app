/**
 * Floor Manager: Job Card Builder — step 1 of 2.
 *
 * Design sheet photo, then the stage sequence, then generate the needle lines
 * and hand off to `JobCardReviewScreen` where they are corrected AND the design
 * details are captured.
 *
 * WHAT MOVED, AND WHY
 * -------------------
 * Design details (design code, stitches per repeat) used to be here, ABOVE the
 * stage sequence, with the needle/colour work two screens later. They are now
 * LAST, after the needles — which is the order the brief asks for and also the
 * order the numbers actually depend on: "stitches per repeat" is the sum of what
 * each needle sews, so entering it before the needles exist is guessing at a
 * figure the next screen can derive.
 *
 * THE STAGE SEQUENCE IS A FIXED SET, NOT A LIST YOU BUILD
 * ------------------------------------------------------
 * Four stages, always in this order. Embroidery and Clipping are mandatory and
 * cannot be turned off; Press and Piko are optional. There is no "+ Add stage"
 * dropdown and no selection-order rule, because the sequence embroidery ->
 * clipping -> press -> piko is the process, not a preference.
 *
 * HANDLED-BY AND SLA ARE NO LONGER ASKED FOR. `fm_set_stage_sequence` still
 * takes them, so the defaults are applied here (see STAGE_DEFAULTS): the first
 * stage runs in-house on the factory's own machines, every later one is a
 * finishing partner's, and the SLA is 24h. The partner itself stays unset —
 * it is chosen per piece at hand-over time (0084), not per order up front.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
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
} from '../../api/endpoints/orders';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import type { StageInput } from '../../models/orderTypes';
import type { StageType } from '../../models/types';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

/** The four stages, in process order. `locked` ones cannot be turned off. */
const ALL_STAGES: { type: StageType; label: string; locked: boolean }[] = [
  { type: 'embroidery', label: 'Embroidery', locked: true },
  { type: 'clipping', label: 'Clipping', locked: true },
  { type: 'press', label: 'Press', locked: false },
  { type: 'piko', label: 'Piko', locked: false },
];

const MANDATORY: StageType[] = ALL_STAGES.filter((s) => s.locked).map((s) => s.type);

/**
 * What the builder no longer asks for.
 *
 * Matches how the floor actually runs (0084): stage 1 is embroidery on the
 * factory's own machines, everything after it goes out to a finishing partner
 * via the delivery person. `partner_id` is deliberately null — `fm_hand_over_stage`
 * names the partner per piece when the work is actually released, and choosing
 * one here would fix a routing decision weeks before it is made.
 */
const STAGE_DEFAULTS = { slaHours: 24 };

export function JobCardBuilderScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const orderId: string = route.params?.orderId;

  const [designPhoto, setDesignPhoto] = useState<LocalPhoto[]>([]);
  const [selected, setSelected] = useState<StageType[]>(MANDATORY);
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

  // Seed from whatever already exists (revisiting the builder after Review).
  // The two mandatory stages are always on, even if an older order was saved
  // without one — the set is not a record of what was chosen, it is the process.
  useEffect(() => {
    if (seeded || existingStages === undefined) return;
    if (existingStages.length) {
      const chosen = existingStages.map((s) => s.stage_type as StageType);
      setSelected(ALL_STAGES.map((s) => s.type).filter((t) => chosen.includes(t) || MANDATORY.includes(t)));
    }
    setSeeded(true);
  }, [existingStages, seeded]);

  const continueMutation = useMutation({
    mutationFn: async () => {
      if (designPhoto[0] && profile?.factory_id) {
        const path = await uploadOrderPhoto(profile.factory_id, orderId, designPhoto[0].uri, 'design');
        await updateOrderPhotos(orderId, order?.cloth_photos ?? [], path);
      }

      // Always sent in ALL_STAGES order, whatever order the chips were tapped.
      const payload: StageInput[] = ALL_STAGES.filter((s) => selected.includes(s.type)).map(
        (s, i) => ({
          stage_type: s.type,
          is_outsourced: i > 0,
          sla_hours: STAGE_DEFAULTS.slaHours,
          partner_id: null,
        })
      );
      await setStageSequence(orderId, payload);

      // Only when there is nothing to lose: re-entering the builder after
      // correcting a mapping on Review must not silently wipe the correction.
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

  function toggle(type: StageType) {
    if (MANDATORY.includes(type)) return;
    setSelected((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }

  if (isLoading || !order) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const repeatCount = (sheets ?? []).reduce((sum, s) => sum + (s.repeats_count ?? 0), 0);
  const busy = continueMutation.isPending;
  const ordered = ALL_STAGES.filter((s) => selected.includes(s.type));

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>
          {order.vendors?.name} · {repeatCount} repeat{repeatCount === 1 ? '' : 's'}
        </Text>

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

        <Section title="Stage sequence">
          <View style={styles.stageGrid}>
            {ALL_STAGES.map((s) => {
              const on = selected.includes(s.type);
              return (
                <Pressable
                  key={s.type}
                  onPress={() => toggle(s.type)}
                  disabled={s.locked}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: s.locked }}
                  accessibilityLabel={
                    s.locked ? `${s.label} — always included` : `${s.label} — optional`
                  }
                  style={({ pressed }) => [
                    styles.stageChip,
                    on && styles.stageChipOn,
                    s.locked && styles.stageChipLocked,
                    pressed && !s.locked && styles.pressed,
                  ]}
                >
                  <View style={[styles.box, on && styles.boxOn]}>
                    {on ? <Ionicons name="checkmark" size={14} color={colors.white} /> : null}
                  </View>
                  <Text style={[styles.stageLabel, on && styles.stageLabelOn]}>{s.label}</Text>
                  {s.locked ? (
                    <Ionicons
                      name="lock-closed"
                      size={12}
                      color={on ? colors.white : colors.inkSubtle}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          {/* The resulting sequence, as one line. Not a rule to read — a
              confirmation of what was just picked. */}
          <Text style={styles.sequenceLine}>
            {ordered.map((s) => s.label).join('  →  ')}
          </Text>
          <Text style={styles.help}>Embroidery and Clipping are always included.</Text>
        </Section>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Continue to needles & colours"
          onPress={() => {
            setError(null);
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

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.title,
    color: colors.ink,
    fontWeight: fontWeight.semibold,
  },
  vendor: {
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
    fontSize: fontSize.body,
    color: colors.ink,
  },
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  stageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stageChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  stageChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  stageChipLocked: { opacity: 0.95 },
  pressed: { opacity: 0.8 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  boxOn: { backgroundColor: colors.primaryDeep, borderColor: colors.primaryDeep },
  stageLabel: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.ink,
  },
  stageLabelOn: { color: colors.white, fontWeight: fontWeight.semibold },
  sequenceLine: {
    marginTop: spacing.md,
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    color: colors.ink,
  },
  help: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.inkMuted, lineHeight: 18 },
  error: { marginBottom: spacing.md, fontSize: fontSize.secondary, color: colors.alert },
});
