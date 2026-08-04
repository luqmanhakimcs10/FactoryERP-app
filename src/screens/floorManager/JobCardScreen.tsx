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
  askForMaterial,
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

  function invalidateAll() {
    for (const k of ['order', 'orderStages', 'jobCard', 'timeline', 'repeats']) {
      queryClient.invalidateQueries({ queryKey: [k, orderId] });
    }
    queryClient.invalidateQueries({ queryKey: ['orders'] });
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

  const askForMaterialMutation = useMutation({
    mutationFn: () => askForMaterial(orderId),
    onSuccess: () => {
      invalidateAll();
      showNextStep(NEXT_STEP.materialRequested);
    },
    onError: (e) => setError(describeDbError(e, 'Job card')),
  });

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
  const totalStitches =
    card?.stitches_per_repeat && repeatCount ? Math.round(card.stitches_per_repeat * repeatCount) : null;
  const busy =
    generateMutation.isPending || vendorInformedMutation.isPending || askForMaterialMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>{order.vendors?.name}</Text>
        <Text style={styles.meta}>
          <Text style={styles.mono}>{repeats?.length ?? 0}</Text> coded repeats ·{' '}
          {sheets?.length ?? 0} sheets
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* ---- 1. Stage sequence ----
            Set upstream on JobCardBuilderScreen; this is read-only recap. */}
        <Section title="1 · Stage sequence">
          {(existingStages ?? []).length ? (
            <View>
              {(existingStages ?? []).map((s) => (
                <View key={s.id} style={styles.card}>
                  <Text style={styles.cardTitle}>
                    {s.sequence}. {s.stage_type}
                    {s.is_outsourced ? ' (outsourced)' : ''}
                  </Text>
                  <Text style={styles.cardLine}>
                    SLA <Text style={styles.mono}>{s.sla_hours}</Text>h
                    {s.finishing_partners ? ` · ${s.finishing_partners.name}` : ''}
                  </Text>
                </View>
              ))}
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

              {!isConfirmed ? (
                <AppButton
                  title={card ? 'Regenerate job card' : 'Generate job card'}
                  variant={card ? 'secondary' : 'primary'}
                  onPress={() => {
                    setError(null);
                    generateMutation.mutate();
                  }}
                  loading={generateMutation.isPending}
                  disabled={busy}
                />
              ) : null}

              {/* Download / share the finished job card. */}
              {lines.length ? (
                <View style={styles.actions}>
                  <AppButton
                    title="Download job card"
                    variant="secondary"
                    loading={exporting === 'download'}
                    disabled={!!exporting}
                    style={{ flex: 1 }}
                    onPress={async () => {
                      if (!card) return;
                      setError(null);
                      setExporting('download');
                      try {
                        await shareJobCardPdf(order, card, lines, existingStages ?? [], repeatCount);
                      } catch (e) {
                        setError(describeDbError(e, 'Job card'));
                      } finally {
                        setExporting(null);
                      }
                    }}
                  />
                  <AppButton
                    title="Share on WhatsApp"
                    variant="secondary"
                    loading={exporting === 'whatsapp'}
                    disabled={!!exporting}
                    style={{ flex: 1 }}
                    onPress={async () => {
                      if (!card) return;
                      setError(null);
                      setExporting('whatsapp');
                      try {
                        // Same OS share sheet as Download — it already lists WhatsApp
                        // as a target, and is reliable where a whatsapp:// deep link
                        // is not (it fails silently if WhatsApp isn't installed).
                        await shareJobCardPdf(order, card, lines, existingStages ?? [], repeatCount);
                      } catch (e) {
                        setError(describeDbError(e, 'Job card'));
                      } finally {
                        setExporting(null);
                      }
                    }}
                  />
                </View>
              ) : null}

              {/* First press locks the needle mapping, advances every repeat to
                  ready-for-production, and is what makes "Ask for material"
                  (below) appear — the client is told at the same time. */}
              {card ? (
                <View style={{ marginTop: spacing.md }}>
                  <AppButton
                    title={card.vendor_informed_at ? 'Client informed ✓' : 'Client informed'}
                    variant="secondary"
                    onPress={() =>
                      card.vendor_informed_at
                        ? undefined
                        : confirmAction(
                            'Client informed',
                            'This notifies the client the job card is ready, locks the needle mapping, and moves every repeat to ready-for-production.',
                            () => {
                              setError(null);
                              vendorInformedMutation.mutate();
                            }
                          )
                    }
                    loading={vendorInformedMutation.isPending}
                    disabled={busy || !!card.vendor_informed_at}
                  />
                  {card.vendor_informed_at ? (
                    <Text style={styles.help}>
                      Client informed {new Date(card.vendor_informed_at).toLocaleString()}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </>
          )}
        </Section>

        {/* ---- 3. Material ----
            Gated on the job card being confirmed, and nothing else — the same
            single condition fm_ask_for_material enforces (migration 0052).
            "Client informed" is the only path to 'confirmed', so in practice
            this appears the moment that button is pressed; keying off the
            status rather than the vendor_informed_at stamp is what stops a
            legacy-confirmed card from being stranded with no way forward. */}
        {isConfirmed && card ? (
          <Section title="3 · Material">
            <AppButton
              title={card.material_requested_at ? 'Material requested ✓' : 'Ask for material'}
              onPress={() => {
                setError(null);
                askForMaterialMutation.mutate();
              }}
              loading={askForMaterialMutation.isPending}
              disabled={busy || !!card.material_requested_at}
            />
            {card.material_requested_at ? (
              <Text style={styles.help}>
                Material requested {new Date(card.material_requested_at).toLocaleString()} — the
                store manager can now see it in Material Requests.
              </Text>
            ) : (
              <Text style={styles.help}>
                Nothing appears in the store manager's Material Requests until you ask.
              </Text>
            )}
          </Section>
        ) : null}

        {isConfirmed ? (
          <ActionBanner
            tone="neutral"
            title="Job card confirmed"
            subtitle={`All ${repeats?.length ?? 0} repeats are ready for production, and the order is released to the store manager for material issue.`}
            style={styles.bannerGap}
          />
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

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
