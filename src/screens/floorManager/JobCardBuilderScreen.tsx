/**
 * Floor Manager: Job Card — ONE screen. (0092)
 *
 * Design sheet photo, stage sequence, and the needle / thread-colour / stitch
 * lines, in that order, on a single page. There is no second screen: the
 * separate `JobCardReview` step is gone, and with it the navigation between two
 * halves of one job.
 *
 * WHY THERE ARE STILL TWO PRESSES ON IT
 * ------------------------------------
 * "Create needle lines" and "Submit job card". Not two steps in disguise — the
 * needle lines are GENERATED SERVER-SIDE from the order's own thread colours
 * (`fm_generate_job_card`), so they cannot be edited before they exist, and
 * they cannot exist before the stage sequence is saved. The first press is what
 * brings them into being; it does not navigate anywhere, it reveals the section
 * below it.
 *
 * Building the draft client-side and committing everything on one press was the
 * alternative, and it costs the thing the review step was originally split out
 * to provide: `order_color_requirements` computes the per-colour cone
 * requirement and the SHORTFALL from saved lines and live stock, so a wrong
 * stitch count is visible while it is still being typed rather than after it
 * has become a purchase order. Keeping the lines real keeps that.
 *
 * THE STAGE SEQUENCE IS A FIXED SET, NOT A LIST YOU BUILD
 * ------------------------------------------------------
 * Four stages, always in this order. Embroidery and Clipping are mandatory and
 * cannot be turned off; Press and Piko are optional. There is no "+ Add stage"
 * dropdown and no selection-order rule, because the sequence embroidery ->
 * clipping -> press -> piko is the process, not a preference.
 *
 * EMBROIDERY IS ALWAYS STAGE 1 AND ALWAYS IN-HOUSE. Every stage after it is a
 * finishing partner's, reached and returned through the delivery person — which
 * is why the delivery cycle begins at the handover that FOLLOWS embroidery and
 * never touches embroidery itself (0092).
 *
 * HANDLED-BY AND SLA ARE NOT ASKED FOR. `fm_set_stage_sequence` still takes
 * them, so the defaults are applied here (see STAGE_DEFAULTS): the first stage
 * runs in-house on the factory's own machines, every later one is a finishing
 * partner's, and the SLA is 24h. The partner itself stays unset — it is chosen
 * per piece at hand-over time (0084), not per order up front.
 *
 * NEEDLE NUMBERS ARE NOT CHOSEN. They are positional and assigned server-side
 * (0053): "+ Add needle" appends the next one, and deleting a line renumbers
 * the rest so the mapping never reads "Needle 1, Needle 3".
 *
 * DESIGN DETAILS COME LAST, and "stitches per repeat" pre-fills from the sum of
 * the needle lines above, because that is exactly what it is. It stays editable:
 * the design may carry an official figure the floor prefers to record.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
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
  updateJobCardLine,
  deleteJobCardLine,
  addJobCardLine,
  getColorRequirements,
  saveJobCardDesign,
} from '../../api/endpoints/orders';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import { useNextStep, NEXT_STEP } from '../../components/ui/NextStepToast';
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

/** The most needles on any machine in the factory — matches the DB cap (0037/0053). */
const MAX_NEEDLES = 6;

/**
 * What the builder does not ask for.
 *
 * Matches how the floor actually runs: stage 1 is embroidery on the factory's
 * own machines, everything after it goes out to a finishing partner via the
 * delivery person. `partner_id` is deliberately null — `fm_hand_over_stage`
 * names the partner per piece when the work is actually released, and choosing
 * one here would fix a routing decision weeks before it is made.
 */
const STAGE_DEFAULTS = { slaHours: 24 };

export function JobCardBuilderScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const showNextStep = useNextStep();
  const { profile } = useAuth();
  const orderId: string = route.params?.orderId;

  // ---- section 1: design sheet ----
  const [designPhoto, setDesignPhoto] = useState<LocalPhoto[]>([]);
  // ---- section 2: stage sequence ----
  const [selected, setSelected] = useState<StageType[]>(MANDATORY);
  const [seeded, setSeeded] = useState(false);
  // ---- section 3: needles, colours, stitches ----
  const [colorEdits, setColorEdits] = useState<Record<string, string>>({});
  const [stitchEdits, setStitchEdits] = useState<Record<string, string>>({});
  const [newColor, setNewColor] = useState('');
  const [newStitches, setNewStitches] = useState('');
  const [adding, setAdding] = useState(false);
  const [savingLineId, setSavingLineId] = useState<string | null>(null);
  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);
  // ---- section 4: design details ----
  const [designCode, setDesignCode] = useState('');
  const [stitchesPerRepeat, setStitchesPerRepeat] = useState('');
  const [designSeeded, setDesignSeeded] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // What the needle stitch counts come to in thread, per colour. Refetched by
  // `invalidate()` below on every line edit, so it tracks what is on screen.
  const { data: colorReqData } = useQuery({
    queryKey: ['colorRequirements', orderId],
    queryFn: () => getColorRequirements(orderId),
    enabled: !!orderId,
  });

  // Seed the stage chips from whatever already exists (revisiting the screen).
  // The two mandatory stages are always on, even if an older order was saved
  // without one — the set is not a record of what was chosen, it is the process.
  useEffect(() => {
    if (seeded || existingStages === undefined) return;
    if (existingStages.length) {
      const chosen = existingStages.map((s) => s.stage_type as StageType);
      setSelected(
        ALL_STAGES.map((s) => s.type).filter((t) => chosen.includes(t) || MANDATORY.includes(t))
      );
    }
    setSeeded(true);
  }, [existingStages, seeded]);

  /**
   * Seed the design fields once the card has loaded.
   *
   * `stitchesPerRepeat` pre-fills from the SUM of the needle lines when the card
   * has no figure yet — `job_card_lines.stitch_count` is per repeat (0082
   * multiplies it by the repeat count), so their sum is the per-repeat total by
   * definition rather than by estimate.
   */
  useEffect(() => {
    if (designSeeded || !jobCard) return;
    if (jobCard.card?.design_code) setDesignCode(jobCard.card.design_code);
    if (jobCard.card?.stitches_per_repeat) {
      setStitchesPerRepeat(String(jobCard.card.stitches_per_repeat));
    } else {
      const summed = (jobCard.lines ?? []).reduce((n, l) => n + Number(l.stitch_count ?? 0), 0);
      if (summed > 0) setStitchesPerRepeat(String(summed));
    }
    setDesignSeeded(true);
  }, [jobCard, designSeeded]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['jobCard', orderId] });
    // The per-colour table reads a DIFFERENT query. Without this it kept
    // showing the requirement computed from the old stitch counts, so a saved
    // edit appeared to have done nothing.
    queryClient.invalidateQueries({ queryKey: ['colorRequirements', orderId] });
  }

  /** Upload the design sheet if a new one was picked. Safe to call twice. */
  async function syncDesignPhoto() {
    if (!designPhoto[0] || !profile?.factory_id) return;
    const path = await uploadOrderPhoto(profile.factory_id, orderId, designPhoto[0].uri, 'design');
    await updateOrderPhotos(orderId, order?.cloth_photos ?? [], path);
    setDesignPhoto([]);
  }

  /** Save the stage sequence exactly as the chips read right now. */
  async function saveStages() {
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
  }

  /**
   * The first press: photo, stage sequence, and the server-generated needle
   * lines. Reveals section 3 rather than navigating anywhere.
   */
  const generateMutation = useMutation({
    mutationFn: async () => {
      await syncDesignPhoto();
      await saveStages();
      await generateJobCard(orderId);
    },
    onSuccess: () => {
      for (const k of ['order', 'orderStages', 'jobCard', 'repeats', 'colorRequirements']) {
        queryClient.invalidateQueries({ queryKey: [k, orderId] });
      }
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e: unknown) => setError(describeDbError(e, 'Job card')),
  });

  const updateLineMutation = useMutation({
    mutationFn: ({
      lineId, needle, color, stitches,
    }: { lineId: string; needle: number; color: string; stitches: number }) =>
      updateJobCardLine(jobCard!.card!.id, lineId, needle, color, stitches),
    onMutate: ({ lineId }) => setSavingLineId(lineId),
    onSuccess: (_data, { lineId }) => {
      setColorEdits((prev) => {
        const next = { ...prev };
        delete next[lineId];
        return next;
      });
      setStitchEdits((prev) => {
        const next = { ...prev };
        delete next[lineId];
        return next;
      });
      invalidate();
    },
    onError: (e: unknown) => setError(describeDbError(e, 'Job card')),
    onSettled: () => setSavingLineId(null),
  });

  const deleteLineMutation = useMutation({
    mutationFn: (lineId: string) => deleteJobCardLine(jobCard!.card!.id, lineId),
    onMutate: (lineId) => setDeletingLineId(lineId),
    onSuccess: () => {
      // Deleting renumbers the remaining lines server-side, so any unsaved
      // colour edits are now keyed to needles that have shifted. Drop them
      // rather than let a stale edit save against the wrong needle.
      setColorEdits({});
      setStitchEdits({});
      invalidate();
    },
    onError: (e: unknown) => setError(describeDbError(e, 'Job card')),
    onSettled: () => setDeletingLineId(null),
  });

  const addLineMutation = useMutation({
    mutationFn: ({ color, stitches }: { color: string; stitches: number }) =>
      addJobCardLine(jobCard!.card!.id, color, stitches),
    onSuccess: () => {
      setNewColor('');
      setNewStitches('');
      setAdding(false);
      invalidate();
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
  const ordered = ALL_STAGES.filter((s) => selected.includes(s.type));
  const lines = (jobCard?.lines ?? []).slice().sort((a, b) => a.needle_number - b.needle_number);
  const hasLines = lines.length > 0;
  const colorReq = colorReqData ?? [];

  // Reference only — the figure on the card and what it comes to over every
  // repeat, so the floor manager is not entering stitches blind.
  const perRepeat = Number(jobCard?.card?.stitches_per_repeat ?? 0) || 0;
  const repeatTotal = perRepeat && repeatCount ? perRepeat * repeatCount : 0;
  /** What the needles come to for ONE repeat — the definition of the field below. */
  const summedStitches = lines.reduce((n, l) => n + Number(l.stitch_count ?? 0), 0);

  const perRepeatTyped = Number(stitchesPerRepeat);
  const orderTotal =
    Number.isFinite(perRepeatTyped) && perRepeatTyped > 0 && repeatCount
      ? perRepeatTyped * repeatCount
      : 0;
  const designHint =
    summedStitches > 0
      ? `The needles above come to ${summedStitches.toLocaleString()} per repeat` +
        (orderTotal ? ` · ${orderTotal.toLocaleString()} across all ${repeatCount} repeats` : '')
      : 'Give every needle above a stitch count and this fills itself in.';

  const anyDirty = lines.some((l) => {
    const c = colorEdits[l.id];
    const st = stitchEdits[l.id];
    return (
      (c !== undefined && c !== l.thread_color_code) ||
      (st !== undefined && st !== (l.stitch_count != null ? String(l.stitch_count) : ''))
    );
  });
  const atCap = lines.length >= MAX_NEEDLES;
  const lineBusy =
    updateLineMutation.isPending || deleteLineMutation.isPending || addLineMutation.isPending;
  const busy = generateMutation.isPending || lineBusy || submitting;

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

        {/* ---- 1. Design sheet ---- */}
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

        {/* ---- 2. Stage sequence ---- */}
        <Section title="Stage sequence">
          <View style={styles.stageGrid}>
            {ALL_STAGES.map((s) => {
              const on = selected.includes(s.type);
              return (
                <Pressable
                  key={s.type}
                  onPress={() => toggle(s.type)}
                  disabled={s.locked || busy}
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
          <Text style={styles.sequenceLine}>{ordered.map((s) => s.label).join('  →  ')}</Text>
          <Text style={styles.help}>
            Embroidery and Clipping are always included. Embroidery runs in-house; every stage
            after it goes out to a finishing partner.
          </Text>
        </Section>

        {/* ---- 3. Needles, colours, stitches ---- */}
        <Section title="Needles & thread colours">
          {!hasLines ? (
            <>
              <Text style={styles.help}>
                One line per thread colour on this order, numbered by needle. They are generated
                from the order's own colours — press below and they appear here, ready to correct
                against the physical machine setup.
              </Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <AppButton
                title="Create needle lines"
                onPress={() => {
                  setError(null);
                  generateMutation.mutate();
                }}
                loading={generateMutation.isPending}
                disabled={busy}
              />
            </>
          ) : (
            <>
              <Text style={styles.help}>
                Correct each needle's thread colour against the physical machine setup, or drop a
                line entirely. Needle numbers follow their order here and are capped at{' '}
                {MAX_NEEDLES}.
              </Text>

              {lines.map((l) => {
                const color = colorEdits[l.id] ?? l.thread_color_code;
                // '' rather than '0' for a line that predates 0082 — those were
                // never captured, and showing 0 would read as "this needle sews
                // nothing".
                const stitches =
                  stitchEdits[l.id] ?? (l.stitch_count != null ? String(l.stitch_count) : '');
                const dirty =
                  color !== l.thread_color_code ||
                  stitches !== (l.stitch_count != null ? String(l.stitch_count) : '');
                return (
                  <View key={l.id} style={styles.row}>
                    <View style={styles.rowHead}>
                      <View style={styles.needleBadge}>
                        <Text style={styles.needleBadgeText}>Needle {l.needle_number}</Text>
                      </View>
                      <Pressable
                        onPress={() => {
                          setError(null);
                          deleteLineMutation.mutate(l.id);
                        }}
                        disabled={lines.length <= 1 || busy}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete needle ${l.needle_number} line`}
                        hitSlop={8}
                        style={styles.deleteBtn}
                      >
                        {deletingLineId === l.id ? (
                          <ActivityIndicator color={colors.alert} size="small" />
                        ) : (
                          <Ionicons
                            name="trash-outline"
                            size={20}
                            color={lines.length <= 1 ? colors.border : colors.alert}
                          />
                        )}
                      </Pressable>
                    </View>
                    <TextField
                      label="Thread colour"
                      value={color}
                      onChangeText={(v) => setColorEdits((prev) => ({ ...prev, [l.id]: v }))}
                      mono
                    />
                    {/* This needle's OWN stitch count — not the order-level
                        "stitches per repeat". Different needles carry different
                        loads in one design, and this is the number the
                        per-colour thread requirement is computed from (0082).
                        NOT auto-filled from the order figure: pre-filling every
                        one with the same number would make a guess look
                        deliberate. */}
                    {perRepeat ? (
                      <Text style={styles.stitchHint}>
                        Order stitches per repeat: {perRepeat.toLocaleString()}
                        {repeatTotal ? ` · ${repeatTotal.toLocaleString()} across all repeats` : ''}
                      </Text>
                    ) : null}
                    <TextField
                      label="Stitches"
                      value={stitches}
                      onChangeText={(v) => setStitchEdits((prev) => ({ ...prev, [l.id]: v }))}
                      numeric
                      required
                      mono
                    />
                    {dirty ? (
                      <AppButton
                        title="Save"
                        variant="secondary"
                        loading={savingLineId === l.id}
                        disabled={busy && savingLineId !== l.id}
                        onPress={() => {
                          setError(null);
                          if (!color.trim()) {
                            setError('A thread colour is required.');
                            return;
                          }
                          const n = Number(stitches);
                          if (!stitches.trim() || !Number.isFinite(n) || n <= 0) {
                            setError('Stitches for this needle must be greater than zero.');
                            return;
                          }
                          updateLineMutation.mutate({
                            lineId: l.id,
                            needle: l.needle_number,
                            color: color.trim(),
                            stitches: Math.round(n),
                          });
                        }}
                        style={styles.saveBtn}
                      />
                    ) : null}
                  </View>
                );
              })}

              {adding && !atCap ? (
                <View style={styles.row}>
                  <View style={styles.rowHead}>
                    <View style={styles.needleBadge}>
                      <Text style={styles.needleBadgeText}>Needle {lines.length + 1}</Text>
                    </View>
                  </View>
                  <TextField
                    label="Thread colour"
                    value={newColor}
                    onChangeText={setNewColor}
                    placeholder="e.g. RED-01"
                    mono
                  />
                  {perRepeat ? (
                    <Text style={styles.stitchHint}>
                      Order stitches per repeat: {perRepeat.toLocaleString()}
                      {repeatTotal ? ` · ${repeatTotal.toLocaleString()} across all repeats` : ''}
                    </Text>
                  ) : null}
                  <TextField
                    label="Stitches"
                    value={newStitches}
                    onChangeText={setNewStitches}
                    placeholder="e.g. 12000"
                    numeric
                    required
                    mono
                  />
                  <View style={styles.addActions}>
                    <AppButton
                      title="Cancel"
                      variant="ghost"
                      disabled={addLineMutation.isPending}
                      onPress={() => {
                        setError(null);
                        setNewColor('');
                        setNewStitches('');
                        setAdding(false);
                      }}
                      style={styles.saveBtn}
                    />
                    <AppButton
                      title="Add"
                      variant="secondary"
                      loading={addLineMutation.isPending}
                      disabled={addLineMutation.isPending}
                      onPress={() => {
                        setError(null);
                        if (!newColor.trim()) {
                          setError('A thread colour is required.');
                          return;
                        }
                        const n = Number(newStitches);
                        if (!newStitches.trim() || !Number.isFinite(n) || n <= 0) {
                          setError('Stitches for this needle must be greater than zero.');
                          return;
                        }
                        addLineMutation.mutate({ color: newColor.trim(), stitches: Math.round(n) });
                      }}
                      style={styles.saveBtn}
                    />
                  </View>
                </View>
              ) : null}

              {atCap ? (
                <Text style={styles.help}>
                  All {MAX_NEEDLES} needles are assigned — delete a line to free one up.
                </Text>
              ) : adding ? null : (
                <Pressable
                  onPress={() => {
                    setError(null);
                    setAdding(true);
                  }}
                  disabled={busy}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.addNeedle, pressed && styles.pressed]}
                >
                  <Text style={styles.addNeedleText}>+ Add needle</Text>
                </Pressable>
              )}
            </>
          )}
        </Section>

        {/* ---- What this order needs, in thread ---- */}
        {hasLines && colorReq.length ? (
          <Section title="Inventory needed">
            <View style={styles.reqTable}>
              <View style={styles.reqHeadRow}>
                <Text style={[styles.reqTh, styles.colColour]}>Colour</Text>
                <Text style={[styles.reqTh, styles.colNum]}>Stitches</Text>
                <Text style={[styles.reqTh, styles.colNum]}>Cones</Text>
                <Text style={[styles.reqTh, styles.colNum]}>Short</Text>
              </View>
              {colorReq.map((c) => (
                <View key={c.color_code} style={styles.reqRow}>
                  <Text style={[styles.reqTd, styles.mono, styles.colColour]}>{c.color_code}</Text>
                  <Text style={[styles.reqTd, styles.mono, styles.colNum]}>
                    {c.stitches_known ? Number(c.total_stitches).toLocaleString() : '—'}
                  </Text>
                  <Text style={[styles.reqTd, styles.mono, styles.colNum]}>
                    {c.stitches_known ? c.cones_needed : '—'}
                  </Text>
                  <Text
                    style={[
                      styles.reqTd,
                      styles.mono,
                      styles.colNum,
                      c.cones_short > 0 && { color: colors.alert },
                    ]}
                  >
                    {c.stitches_known ? (c.cones_short > 0 ? c.cones_short : '0') : '?'}
                  </Text>
                </View>
              ))}
            </View>
            <Text style={styles.help}>
              350,000 stitches per cone.{' '}
              {colorReq.some((c) => !c.stitches_known)
                ? 'A dash means a needle on that colour has no stitch count yet.'
                : 'Shortfalls are ordered automatically when the material is requested.'}
            </Text>
          </Section>
        ) : null}

        {/* ---- 4. Design details, last ---- */}
        {hasLines ? (
          <>
            <Section title="Design details">
              <TextField
                label="Design code"
                value={designCode}
                onChangeText={setDesignCode}
                placeholder="e.g. DS-4785"
                required
                mono
              />
              <TextField
                label="Stitches per repeat"
                value={stitchesPerRepeat}
                onChangeText={setStitchesPerRepeat}
                numeric
                required
                mono
              />
              <Text style={styles.help}>{designHint}</Text>
            </Section>

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {anyDirty ? <Text style={styles.help}>Save your changes before submitting.</Text> : null}

            <AppButton
              title="Submit job card"
              loading={submitting}
              disabled={busy}
              onPress={async () => {
                setError(null);
                if (anyDirty) {
                  setError('Save your changes before submitting.');
                  return;
                }
                if (!designCode.trim()) {
                  setError('A design code is required.');
                  return;
                }
                const value = Number(stitchesPerRepeat);
                if (!stitchesPerRepeat.trim() || !Number.isFinite(value) || value <= 0) {
                  setError('Stitches per repeat must be a positive number.');
                  return;
                }

                setSubmitting(true);
                try {
                  // The photo and the stage chips are still editable at this
                  // point, so both are re-committed here. `syncDesignPhoto`
                  // no-ops when nothing new was picked, and re-saving an
                  // unchanged sequence is the same rows again.
                  await syncDesignPhoto();
                  await saveStages();
                  await saveJobCardDesign(orderId, designCode.trim(), value);
                  for (const k of ['order', 'orderStages', 'jobCard']) {
                    queryClient.invalidateQueries({ queryKey: [k, orderId] });
                  }
                  queryClient.invalidateQueries({ queryKey: ['orders'] });
                  // Fired here rather than at generation: this is the press that
                  // lands the user on the screen holding the next action, so the
                  // guidance points at something they can see.
                  showNextStep(NEXT_STEP.jobCardCreated);
                  navigation.replace('JobCard', { orderId });
                } catch (e) {
                  setError(describeDbError(e, 'Job card'));
                } finally {
                  setSubmitting(false);
                }
              }}
            />
          </>
        ) : null}
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
  help: {
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    lineHeight: 20,
  },
  stitchHint: { fontSize: fontSize.caption, color: colors.inkMuted, marginBottom: spacing.xs },
  row: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  needleBadge: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.border,
  },
  needleBadgeText: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.secondary,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  deleteBtn: { padding: spacing.xs },
  saveBtn: {
    marginTop: spacing.xs,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    alignSelf: 'flex-start',
  },
  addActions: { flexDirection: 'row', gap: spacing.sm },
  addNeedle: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  addNeedleText: { fontSize: fontSize.secondary, color: colors.primary, fontWeight: fontWeight.medium },
  reqTable: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  reqHeadRow: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  reqRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
  reqTh: {
    padding: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
  },
  reqTd: { padding: spacing.sm, fontSize: fontSize.secondary, color: colors.ink },
  colColour: { flex: 1.4 },
  colNum: { flex: 1, textAlign: 'right' },
  mono: { fontFamily: fontFamily.mono },
  error: { marginBottom: spacing.md, fontSize: fontSize.secondary, color: colors.alert },
});

export default JobCardBuilderScreen;
