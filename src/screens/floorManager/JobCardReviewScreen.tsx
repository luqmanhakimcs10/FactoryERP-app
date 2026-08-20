/**
 * Floor Manager: Job Card Review — step 2 of 2.
 *
 * The distinct review step the Builder hands off to — every needle's assigned
 * colour is editable here (the Builder only ever shows a read-only preview), a
 * line can be dropped, and a needle can be added one at a time.
 *
 * TWO THINGS THIS SCREEN GAINED
 * -----------------------------
 * 1. WHAT THE STITCHES COST IN THREAD. The per-colour cone requirement and
 *    shortfall used to live only on the job card detail screen, one step later.
 *    It is the direct consequence of the numbers being typed here, so it is
 *    here: a wrong stitch figure is noticeable while it is still being entered,
 *    not after it has become a purchase order.
 *
 * 2. THE DESIGN DETAILS, which used to be the FIRST thing the Builder asked for.
 *    They are last now — and "stitches per repeat" pre-fills from the sum of the
 *    needle lines above, because that is exactly what it is. It stays editable:
 *    the design may carry an official figure the floor prefers to record.
 *
 * There is no progress timeline on this screen. There never was one, and none
 * was added: this screen is the needle/colour/stitch data and nothing else.
 *
 * Needle numbers are NOT chosen here. They are positional and assigned
 * server-side (0053): "+ Add needle" appends the next one, and deleting a line
 * renumbers the rest so the mapping never reads "Needle 1, Needle 3". Showing a
 * 1..6 picker per line, as this screen used to, offered a choice that was
 * already implied by position and repeated a six-button bank down the page.
 *
 * "Submit job card" is a navigation gate into the existing job card detail
 * screen (download/share/vendor confirmation/material) — it doesn't introduce a
 * new DB transition of its own.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { Ionicons } from '@expo/vector-icons';
import {
  getOrder,
  getJobCard,
  updateJobCardLine,
  deleteJobCardLine,
  addJobCardLine,
  listSheets,
  getColorRequirements,
  saveJobCardDesign,
} from '../../api/endpoints/orders';
import { describeDbError } from '../../utils/errors';
import { useNextStep, NEXT_STEP } from '../../components/ui/NextStepToast';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

/** The most needles on any machine in the factory — matches the DB cap (0037/0053). */
const MAX_NEEDLES = 6;

export function JobCardReviewScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const showNextStep = useNextStep();
  const orderId: string = route.params?.orderId;

  const [designCode, setDesignCode] = useState('');
  const [stitchesPerRepeat, setStitchesPerRepeat] = useState('');
  const [designSeeded, setDesignSeeded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [colorEdits, setColorEdits] = useState<Record<string, string>>({});
  const [newColor, setNewColor] = useState('');
  const [newStitches, setNewStitches] = useState('');
  // Keyed by line id, like colorEdits — an unsaved stitch figure per line.
  const [stitchEdits, setStitchEdits] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingLineId, setSavingLineId] = useState<string | null>(null);
  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);

  const { data: order, isLoading } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId),
  });
  const { data: sheets } = useQuery({
    queryKey: ['sheets', orderId],
    queryFn: () => listSheets(orderId),
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

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['jobCard', orderId] });
    // The Job Card's per-colour table reads a DIFFERENT query. Without this it
    // kept showing the requirement computed from the old stitch counts, so a
    // saved edit appeared to have done nothing.
    queryClient.invalidateQueries({ queryKey: ['colorRequirements', orderId] });
  }

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

  if (isLoading || !order || !jobCard) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  // Reference only — the Builder's figure and what it comes to over every
  // repeat, so the floor manager is not entering stitches blind.
  const perRepeat = Number(jobCard.card?.stitches_per_repeat ?? 0) || 0;
  const totalRepeats = (sheets ?? []).reduce(
    (n, sh) => n + Number(sh.repeats_count ?? 0), 0);
  const repeatTotal = perRepeat && totalRepeats ? perRepeat * totalRepeats : 0;

  const lines = (jobCard.lines ?? []).slice().sort((a, b) => a.needle_number - b.needle_number);
  const colorReq = colorReqData ?? [];
  /** What the needles come to for ONE repeat — the definition of the field below. */
  const summedStitches = lines.reduce((n, l) => n + Number(l.stitch_count ?? 0), 0);

  /**
   * The line under "Stitches per repeat".
   *
   * Assembled here rather than inline: with no needles counted and no figure
   * typed there is nothing true to say, and the inline version was emitting a
   * dangling "· — across all 1 repeats" in exactly that state.
   */
  const perRepeatTyped = Number(stitchesPerRepeat);
  const orderTotal =
    Number.isFinite(perRepeatTyped) && perRepeatTyped > 0 && totalRepeats
      ? perRepeatTyped * totalRepeats
      : 0;
  const designHint =
    summedStitches > 0
      ? `The needles above come to ${summedStitches.toLocaleString()} per repeat` +
        (orderTotal ? ` · ${orderTotal.toLocaleString()} across all ${totalRepeats} repeats` : '')
      : 'Give every needle above a stitch count and this fills itself in.';
  const anyDirty = lines.some((l) => {
    const e = colorEdits[l.id];
    return e !== undefined && e !== l.thread_color_code;
  });
  const atCap = lines.length >= MAX_NEEDLES;
  const busy = updateLineMutation.isPending || deleteLineMutation.isPending || addLineMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>{order.vendors?.name}</Text>

        <Text style={styles.sectionTitle}>Needle & color lines</Text>
        <Text style={styles.help}>
          Correct each needle's thread colour against the physical machine setup, or drop a line
          entirely, before submitting. Needle numbers follow their order here and are capped at{' '}
          {MAX_NEEDLES}.
        </Text>

        {lines.map((l) => {
          const color = colorEdits[l.id] ?? l.thread_color_code;
          // '' rather than '0' for a line that predates 0082 — those were never
          // captured, and showing 0 would read as "this needle sews nothing".
          const stitches = stitchEdits[l.id] ?? (l.stitch_count != null ? String(l.stitch_count) : '');
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
              {/* This needle's OWN stitch count — not the order-level "stitches
                  per repeat". Different needles carry different loads in one
                  design, and this is the number the per-colour thread
                  requirement is computed from (0082). */}
              {/* The order-level figure, for reference. NOT auto-filled: needles
                  legitimately carry different loads, and pre-filling every one
                  with the same number would make a guess look deliberate. */}
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

        {/* ---- What this order needs, in thread ---- */}
        {colorReq.length ? (
          <View style={styles.reqBlock}>
            <Text style={styles.sectionTitle}>Inventory needed</Text>
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
          </View>
        ) : null}

        {/* ---- Design details, last ---- */}
        <Text style={styles.sectionTitle}>Design details</Text>
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
        <Text style={styles.help}>
          {designHint}
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {anyDirty ? <Text style={styles.help}>Save your changes before submitting.</Text> : null}

        <AppButton
          title="Submit job card"
          loading={submitting}
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
            const perRepeatValue = Number(stitchesPerRepeat);
            if (!stitchesPerRepeat.trim() || !Number.isFinite(perRepeatValue) || perRepeatValue <= 0) {
              setError('Stitches per repeat must be a positive number.');
              return;
            }

            setSubmitting(true);
            try {
              await saveJobCardDesign(orderId, designCode.trim(), perRepeatValue);
              queryClient.invalidateQueries({ queryKey: ['jobCard', orderId] });
              // Fired here rather than at generateJobCard in the Builder: this
              // is the press that lands the user on the screen holding the next
              // action, so the guidance points at something they can see.
              showNextStep(NEXT_STEP.jobCardCreated);
              navigation.replace('JobCard', { orderId });
            } catch (e) {
              setError(describeDbError(e, 'Job card'));
            } finally {
              setSubmitting(false);
            }
          }}
          disabled={busy || submitting}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stitchHint: { fontSize: fontSize.caption, color: colors.slate, marginBottom: spacing.xs },
  reqBlock: { marginBottom: spacing.xl },
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
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { marginTop: spacing.xs, marginBottom: spacing.lg, fontSize: fontSize.body, color: colors.indigoDeep },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  help: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.md, lineHeight: 20 },
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
    color: colors.indigoDeep,
    fontWeight: fontWeight.medium,
  },
  deleteBtn: { padding: spacing.xs },
  saveBtn: { marginTop: spacing.xs, minHeight: 40, paddingHorizontal: spacing.md, alignSelf: 'flex-start' },
  addActions: { flexDirection: 'row', gap: spacing.sm },
  addNeedle: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.indigo,
  },
  addNeedleText: { fontSize: fontSize.secondary, color: colors.indigo, fontWeight: fontWeight.medium },
  pressed: { opacity: 0.75 },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
});
