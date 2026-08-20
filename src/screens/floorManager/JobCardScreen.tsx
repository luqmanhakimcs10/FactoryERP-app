/**
 * Floor Manager: Job Card detail — Client informed → Material (Stage 3, tail end).
 *
 * The design details, stage sequence, and needle/colour mapping are all set
 * upstream now, on JobCardBuilderScreen and JobCardReviewScreen — this screen
 * only displays them read-only and drives what comes after: download/share,
 * "Client informed", and "Ask for material". "Regenerate job card" stays as
 * an escape hatch for when the underlying sheets change after the initial
 * generation.
 *
 * "Client informed" is the confirmation action: the first time it's pressed,
 * it locks the needle mapping, advances every repeat to ready_for_production,
 * and flips the order to job_card_confirmed (see fm_mark_vendor_informed,
 * migration 0050) — the same things a separate "vendor confirmation loop"
 * used to require before material could ever be requested, which is why that
 * loop is gone: it was blocking "Ask for material" from ever being reachable,
 * and was never part of the spec for this screen to begin with. Pressing it
 * again afterwards is a no-op re-stamp, not a repeat of the lock.
 *
 * "Ask for material" gates on exactly one thing — job_cards.status =
 * 'confirmed' — matching the single server-side gate in migration 0052. It
 * deliberately does NOT also check vendor_informed_at: cards confirmed through
 * the retired fm_confirm_job_card path have a null stamp, and a second gate
 * here would strand them the same way the vendor loop once did.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { StitchLine } from '../../components/ui/StitchLine';
import { StageProgress } from '../../components/ui/StageProgress';
import { StatusPill, OrderStatusPill } from '../../components/ui/StatusPill';
import {
  getOrder,
  listSheets,
  listOrderStages,
  listRepeats,
  getJobCard,
  getOrderTimeline,
  generateJobCard,
  markVendorInformed,
  getColorRequirements,
} from '../../api/endpoints/orders';
import { describeDbError } from '../../utils/errors';
import { shareJobCardPdf } from '../../utils/jobCardExport';
import { useNextStep, NEXT_STEP } from '../../components/ui/NextStepToast';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Alert } = require('react-native');
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm', onPress: onConfirm },
  ]);
}

export function JobCardScreen() {
  const route = useRoute<any>();
  const queryClient = useQueryClient();
  const showNextStep = useNextStep();
  const orderId: string = route.params?.orderId;

  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'download' | 'whatsapp' | null>(null);

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
  const { data: repeats } = useQuery({
    queryKey: ['repeats', orderId],
    queryFn: () => listRepeats(orderId),
  });
  const { data: jobCard } = useQuery({
    queryKey: ['jobCard', orderId],
    queryFn: () => getJobCard(orderId),
  });
  const { data: timeline } = useQuery({
    queryKey: ['timeline', orderId],
    queryFn: () => getOrderTimeline(orderId),
  });
  // Per-colour requirement from the real per-needle counts (0082).
  //
  // ABOVE the loading early-return, with every other hook. It used to sit below
  // it, which is a hooks-order violation: the first render bails out before
  // reaching it and the next one calls one hook more, so React tears the screen
  // down with "rendered more hooks than during the previous render".
  const { data: colorReqData } = useQuery({
    queryKey: ['colorRequirements', orderId],
    queryFn: () => getColorRequirements(orderId),
    enabled: !!orderId,
  });

  function invalidateAll() {
    for (const k of ['order', 'orderStages', 'jobCard', 'timeline', 'repeats']) {
      queryClient.invalidateQueries({ queryKey: [k, orderId] });
    }
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  }

  /**
   * Download and Share are the SAME operation: render the PDF, hand it to the
   * OS share sheet. That sheet already lists WhatsApp on both platforms, and is
   * reliable where a `whatsapp://` deep link is not — that scheme fails silently
   * when WhatsApp is not installed. The two buttons differ only in what they
   * promise, which is what the floor manager is looking for.
   */
  async function exportCard(kind: 'download' | 'whatsapp') {
    if (!card) return;
    setError(null);
    setExporting(kind);
    try {
      await shareJobCardPdf(order!, card, lines, existingStages ?? [], repeatCount);
    } catch (e) {
      setError(describeDbError(e, 'Job card'));
    } finally {
      setExporting(null);
    }
  }

  const generateMutation = useMutation({
    mutationFn: () => generateJobCard(orderId),
    onSuccess: () => {
      invalidateAll();
      showNextStep(NEXT_STEP.jobCardCreated);
    },
    onError: (e) => setError(describeDbError(e, 'Job card')),
  });

  const vendorInformedMutation = useMutation({
    mutationFn: () => markVendorInformed(orderId),
    onSuccess: () => {
      invalidateAll();
      showNextStep(NEXT_STEP.clientInformed);
    },
    onError: (e) => setError(describeDbError(e, 'Job card')),
  });

  // `askForMaterialMutation` was here. "Ask for material" was a second press
  // for a decision already made: 0088 folded the material request into
  // `fm_mark_vendor_informed`, so approving the card is what releases it to the
  // store manager.

  if (isLoading || !order) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const card = jobCard?.card ?? null;
  const lines = jobCard?.lines ?? [];
  const isConfirmed = card?.status === 'confirmed';
  // Total planned repeats (from sheets), not just how many have been coded so
  // far — matches the same total-stitches basis used on the Job Card Builder.
  const repeatCount = (sheets ?? []).reduce((sum, s) => sum + (s.repeats_count ?? 0), 0);
  // Empty until needle lines exist, which is why the table renders
  // conditionally rather than showing a row of zeroes.
  const colorReq = colorReqData ?? [];

  const totalStitches =
    card?.stitches_per_repeat && repeatCount ? Math.round(card.stitches_per_repeat * repeatCount) : null;
  const busy = generateMutation.isPending || vendorInformedMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>{order.vendors?.name}</Text>
        {/* Repeats only, and counted properly. The sheet count sat beside this
            and is gone with the rest of the sheet copy — it is not a quantity
            the floor manager ordered or can act on. */}
        <Text style={styles.meta}>
          <Text style={styles.mono}>{repeats?.length ?? 0}</Text> of{' '}
          <Text style={styles.mono}>{repeatCount}</Text> repeat
          {repeatCount === 1 ? '' : 's'} coded
        </Text>

        {/* ---- The four actions, before anything that needs scrolling ----
            These are what the floor manager opens this screen to press. They
            used to sit below the needle table and the colour requirement, far
            enough down that "Client informed" was regularly missed. */}
        {lines.length || card ? (
          <View style={styles.actionBar}>
            {!isConfirmed ? (
              <AppButton
                title={card ? 'Regenerate' : 'Generate'}
                variant="secondary"
                size="sm"
                icon="refresh-outline"
                onPress={() => {
                  setError(null);
                  generateMutation.mutate();
                }}
                loading={generateMutation.isPending}
                disabled={busy}
                style={styles.actionBtn}
              />
            ) : null}

            {lines.length && card ? (
              <>
                <AppButton
                  title="Download"
                  variant="secondary"
                  size="sm"
                  icon="download-outline"
                  loading={exporting === 'download'}
                  disabled={!!exporting}
                  style={styles.actionBtn}
                  onPress={() => exportCard('download')}
                />
                <AppButton
                  title="Share on WhatsApp"
                  variant="secondary"
                  size="sm"
                  icon="logo-whatsapp"
                  loading={exporting === 'whatsapp'}
                  disabled={!!exporting}
                  style={styles.actionBtn}
                  onPress={() => exportCard('whatsapp')}
                />
              </>
            ) : null}

            {card ? (
              <AppButton
                title={card.vendor_informed_at ? 'Client Approved ✓' : 'Client Approved'}
                size="sm"
                icon="checkmark-done-outline"
                onPress={() =>
                  card.vendor_informed_at
                    ? undefined
                    : confirmAction(
                        'Client Approved',
                        'This locks the needle mapping, moves every repeat to ready-for-production, and asks the store manager for the material.',
                        () => {
                          setError(null);
                          vendorInformedMutation.mutate();
                        }
                      )
                }
                loading={vendorInformedMutation.isPending}
                disabled={busy || !!card.vendor_informed_at}
                style={styles.actionBtn}
              />
            ) : null}
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* ---- 1. Stage sequence ----
            One line, arrow-connected. It was four stacked cards carrying a
            sequence number and an SLA each — a fifth of the screen spent
            restating a fixed four-step process nobody can change from here. */}
        <Section title="1 · Stage sequence">
          {(existingStages ?? []).length ? (
            <View>
              <Text style={styles.sequenceLine}>
                {(existingStages ?? [])
                  .slice()
                  .sort((a, b) => a.sequence - b.sequence)
                  .map((s) => s.stage_type.replace(/_/g, ' '))
                  .join('  →  ')}
              </Text>
              {isConfirmed ? (
                <Text style={styles.lockedNote}>Locked — the job card is confirmed.</Text>
              ) : null}
            </View>
          ) : (
            <Text style={styles.help}>Not set yet.</Text>
          )}

          {card?.design_code ? (
            <View style={styles.designRecap}>
              <Text style={styles.designRecapLine}>
                Design <Text style={styles.mono}>{card.design_code}</Text>
                {card.stitches_per_repeat
                  ? ` · ${card.stitches_per_repeat.toLocaleString()} stitches/repeat`
                  : ''}
                {totalStitches !== null ? ` · ${totalStitches.toLocaleString()} total stitches` : ''}
              </Text>
            </View>
          ) : null}
        </Section>

        {/* ---- 2. Job card ---- */}
        <Section title="2 · Job card">
          {!existingStages?.length ? (
            <Text style={styles.help}>Set a stage sequence first, from the job card builder.</Text>
          ) : (
            <>
              <View style={styles.cardStatusRow}>
                <StatusPill
                  label={
                    card
                      ? `${card.status === 'draft' ? 'Draft' : card.status === 'shared' ? 'Shared' : 'Confirmed'} · rev ${card.revision}`
                      : 'Not generated'
                  }
                  color={
                    card?.status === 'confirmed'
                      ? colors.success
                      : card?.status === 'shared'
                        ? colors.brass
                        : colors.slate
                  }
                />
              </View>

              {lines.length ? (
                <View style={styles.table}>
                  <View style={styles.tableHeadRow}>
                    <Text style={[styles.th, styles.colNeedle]}>Needle</Text>
                    <Text style={[styles.th, styles.colColor]}>Thread colour</Text>
                    <Text style={[styles.th, styles.colStitch]}>Stitches</Text>
                  </View>
                  {lines.map((l) => (
                    <View key={l.id} style={styles.tableRow}>
                      {/* Mono for needle numbers and colour codes, per the design system. */}
                      <Text style={[styles.td, styles.mono, styles.colNeedle]}>
                        {String(l.needle_number).padStart(2, '0')}
                      </Text>
                      <Text style={[styles.td, styles.mono, styles.colColor]}>
                        {l.thread_color_code}
                      </Text>
                      <Text style={[styles.td, styles.mono, styles.colStitch]}>
                        {l.stitch_count?.toLocaleString() ?? '—'}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* What those stitch counts actually MEAN for thread.
                  The needle table above is the input; this is the consequence,
                  and putting them on one screen is what makes a wrong stitch
                  figure noticeable before it becomes a wrong purchase order. */}
              {colorReq.length ? (
                <View style={styles.table}>
                  <View style={styles.tableHeadRow}>
                    <Text style={[styles.th, styles.colColor]}>Colour</Text>
                    <Text style={[styles.th, styles.colStitch]}>Stitches</Text>
                    <Text style={[styles.th, styles.colStitch]}>Cones</Text>
                    <Text style={[styles.th, styles.colStitch]}>Short</Text>
                  </View>
                  {colorReq.map((c) => (
                    <View key={c.color_code} style={styles.tableRow}>
                      <Text style={[styles.td, styles.mono, styles.colColor]}>{c.color_code}</Text>
                      <Text style={[styles.td, styles.mono, styles.colStitch]}>
                        {c.stitches_known ? Number(c.total_stitches).toLocaleString() : '—'}
                      </Text>
                      <Text style={[styles.td, styles.mono, styles.colStitch]}>
                        {c.stitches_known ? c.cones_needed : '—'}
                      </Text>
                      <Text
                        style={[
                          styles.td, styles.mono, styles.colStitch,
                          c.cones_short > 0 && { color: colors.alert },
                        ]}
                      >
                        {c.stitches_known ? (c.cones_short > 0 ? c.cones_short : '0') : '?'}
                      </Text>
                    </View>
                  ))}
                  <Text style={styles.reqNote}>
                    350,000 stitches per cone.{' '}
                    {colorReq.some((c) => !c.stitches_known)
                      ? 'A dash means that colour has a needle with no stitch count entered yet.'
                      : 'Shortfalls are ordered automatically when material is requested.'}
                  </Text>
                </View>
              ) : null}

              {/* The Regenerate / Download / Share / Client Approved buttons were
                  here, below everything. They are in the action bar at the top
                  of this screen now. */}
            </>
          )}
        </Section>

        {/* The "3 · Material" section was here, with an "Ask for material"
            button gated on the card being confirmed. Both are gone: 0088 folded
            the request into Client Approved, so by the time this screen could
            have shown the button the request has already been made. */}

        {isConfirmed ? (
          <ActionBanner
            tone="neutral"
            title="Job card confirmed"
            subtitle={`All ${repeats?.length ?? 0} repeats are ready for production, and the material has been requested from the store manager.`}
            style={styles.bannerGap}
          />
        ) : null}

        {/* ---- Progress (from repeat_stage_history) ---- */}
        {timeline?.length ? (
          <Section title="Progress">
            <StageProgress steps={timeline} orientation="vertical" />
          </Section>
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
  actionBar: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  actionBtn: { flexGrow: 1, flexBasis: '46%' },
  sequenceLine: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    color: colors.ink,
    textTransform: 'capitalize',
  },
  reqNote: { padding: spacing.md, fontSize: fontSize.caption, color: colors.slate },
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.indigoDeep },
  meta: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
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
  help: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.md, lineHeight: 20 },
  designRecap: { marginTop: spacing.sm },
  designRecapLine: { fontSize: fontSize.secondary, color: colors.slate },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardTitle: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep, textTransform: 'capitalize' },
  cardLine: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  cardStatusRow: { marginBottom: spacing.md },
  lockedNote: { fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
  },
  tableHeadRow: { flexDirection: 'row', backgroundColor: colors.indigo, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  th: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  td: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  colNeedle: { width: 70 },
  colColor: { flex: 1 },
  colStitch: { width: 90, textAlign: 'right' },
  mono: { fontFamily: fontFamily.mono },
  actions: { flexDirection: 'row', gap: spacing.md },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
});
