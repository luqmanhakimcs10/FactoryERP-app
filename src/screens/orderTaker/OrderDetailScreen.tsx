/**
 * Order Detail / Status Tracker.
 *
 * READ-ONLY for the order taker once the order is submitted — the brief requires
 * this be enforced, not merely implied by omitting buttons. Three layers do it:
 *   1. this screen renders no mutating control for the order taker;
 *   2. the RLS UPDATE policy on `orders` only matches rows with status='draft';
 *   3. inspection/coding/job-card transitions are RPCs that assert the caller's
 *      role, so an order taker calling them directly is refused by the database.
 *
 * The timeline comes from `order_timeline()`, which derives repeat-level progress
 * from repeat_stage_history — not from a hardcoded list of steps.
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { StageProgress } from '../../components/ui/StageProgress';
import { StitchLine } from '../../components/ui/StitchLine';
import { OrderStatusPill, StatusPill } from '../../components/ui/StatusPill';
import {
  getOrder,
  listSheets,
  getOrderTimeline,
  listOrderDamage,
  listOrderPurchaseOrders,
  listRepeats,
} from '../../api/endpoints/orders';
import { getPhotoUrls } from '../../api/endpoints/storage';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

/** Accountability tag colours are consistent app-wide, per the design system. */
const RESPONSIBLE_COLOR: Record<string, string> = {
  vendor: colors.accountVendor,
  worker: colors.accountWorker,
  partner: colors.accountPartner,
};

export function OrderDetailScreen() {
  const route = useRoute<any>();
  const orderId: string = route.params?.orderId;
  const justSubmitted = route.params?.justSubmitted;

  const { data: order, isLoading, isError, error } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId),
  });
  const { data: sheets } = useQuery({
    queryKey: ['sheets', orderId],
    queryFn: () => listSheets(orderId),
  });
  const { data: timeline } = useQuery({
    queryKey: ['timeline', orderId],
    queryFn: () => getOrderTimeline(orderId),
  });
  const { data: damage } = useQuery({
    queryKey: ['damage', orderId],
    queryFn: () => listOrderDamage(orderId),
  });
  const { data: pos } = useQuery({
    queryKey: ['orderPos', orderId],
    queryFn: () => listOrderPurchaseOrders(orderId),
  });
  const { data: repeats } = useQuery({
    queryKey: ['repeats', orderId],
    queryFn: () => listRepeats(orderId),
  });
  const { data: photoUrls } = useQuery({
    queryKey: ['orderPhotos', orderId, order?.cloth_photos?.length, order?.design_sheet_url],
    queryFn: () =>
      getPhotoUrls(
        [...(order?.cloth_photos ?? []), order?.design_sheet_url].filter(Boolean) as string[]
      ),
    enabled: !!order,
  });

  if (isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }
  if (isError || !order) {
    return (
      <Screen>
        <Text style={styles.body}>{describeDbError(error, 'Order')}</Text>
      </Screen>
    );
  }

  const totalRepeats = (sheets ?? []).reduce((n, s) => n + s.repeats_count, 0);

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code ?? '(draft)'}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>{order.vendors?.name ?? '—'}</Text>

        {/* Just-submitted outcome of the thread check */}
        {justSubmitted ? (
          <ActionBanner
            tone={justSubmitted.status === 'awaiting_procurement' ? 'attention' : 'neutral'}
            title={
              justSubmitted.status === 'awaiting_procurement'
                ? 'Thread shortfall — procurement notified'
                : 'Thread stock is sufficient'
            }
            subtitle={
              justSubmitted.status === 'awaiting_procurement'
                ? `Purchase order ${justSubmitted.po_code} was raised automatically. The order waits on procurement.`
                : 'The order is queued for incoming cloth inspection.'
            }
            style={styles.bannerGap}
          />
        ) : null}

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* ---- Timeline (from repeat_stage_history) ---- */}
        <Section title="Progress">
          {timeline?.length ? (
            <StageProgress steps={timeline} orientation="vertical" />
          ) : (
            <Text style={styles.body}>No progress recorded yet.</Text>
          )}
        </Section>

        {/* ---- Auto-generated POs (read-only in this phase) ---- */}
        {pos?.length ? (
          <Section title="Purchase orders">
            {pos.map((po) => (
              <View key={po.id} style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.mono}>{po.po_code}</Text>
                  <StatusPill
                    label={po.auto_created ? 'Auto-generated' : 'Manual'}
                    color={colors.warning}
                  />
                </View>
                {(po.po_items ?? []).map((it, i) => (
                  <Text key={i} style={styles.cardLine}>
                    <Text style={styles.mono}>{it.color_code}</Text> —{' '}
                    <Text style={styles.mono}>{Number(it.quantity_meters).toFixed(2)}</Text> m short
                  </Text>
                ))}
                <Text style={styles.readOnlyNote}>
                  Procurement handles this from their own queue.
                </Text>
              </View>
            ))}
          </Section>
        ) : null}

        {/* ---- Sheets ---- */}
        <Section title={`Sheets (${sheets?.length ?? 0})`}>
          {(sheets ?? []).map((s) => (
            <View key={s.id} style={styles.card}>
              <Text style={styles.cardTitle}>
                Sheet {s.sheet_number} · {s.color_assignment}
              </Text>
              <Text style={styles.cardLine}>
                <Text style={styles.mono}>{s.repeats_count}</Text> repeats ·{' '}
                <Text style={styles.mono}>{s.stitch_count.toLocaleString()}</Text> stitches each
              </Text>
              <Text style={styles.cardLine}>
                Threads: <Text style={styles.mono}>{s.thread_color_codes.join(', ') || '—'}</Text>
              </Text>
            </View>
          ))}
          <Text style={styles.totalLine}>
            Total: <Text style={styles.mono}>{totalRepeats}</Text> repeats
            {repeats?.length ? (
              <>
                {' · '}
                <Text style={styles.mono}>{repeats.length}</Text> coded
              </>
            ) : null}
          </Text>
        </Section>

        {/* ---- Coded repeats ---- */}
        {repeats?.length ? (
          <Section title={`Coded repeats (${repeats.length})`}>
            <View style={styles.codeGrid}>
              {repeats.map((r) => (
                <View key={r.id} style={styles.codeChip}>
                  <Text style={styles.codeChipText}>{r.repeat_code}</Text>
                </View>
              ))}
            </View>
          </Section>
        ) : null}

        {/* ---- Damage records ---- */}
        <Section title={`Damage records (${damage?.length ?? 0})`}>
          {damage?.length ? (
            damage.map((d) => (
              <View key={d.id} style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>
                    {DAMAGE_TYPE_LABEL[d.damage_type] ?? d.damage_type}
                  </Text>
                  <StatusPill
                    label={`${d.responsible_type} accountable`}
                    color={RESPONSIBLE_COLOR[d.responsible_type] ?? colors.slate}
                  />
                </View>
                <Text style={styles.cardLine}>
                  Stage: {d.stage_type.replace(/_/g, ' ')}
                  {d.sheets ? ` · Sheet ${d.sheets.sheet_number}` : ''}
                  {d.repeats ? ` · ${d.repeats.repeat_code}` : ''}
                </Text>
                {d.note ? <Text style={styles.cardLine}>{d.note}</Text> : null}
              </View>
            ))
          ) : (
            <Text style={styles.body}>None recorded.</Text>
          )}
        </Section>

        {/* ---- Photos ---- */}
        {order.cloth_photos?.length || order.design_sheet_url ? (
          <Section title="Photos">
            <View style={styles.photoGrid}>
              {(order.cloth_photos ?? []).map((p) =>
                photoUrls?.[p] ? (
                  <Image key={p} source={{ uri: photoUrls[p] }} style={styles.photo} />
                ) : null
              )}
              {order.design_sheet_url && photoUrls?.[order.design_sheet_url] ? (
                <View>
                  <Image
                    source={{ uri: photoUrls[order.design_sheet_url] }}
                    style={styles.photo}
                  />
                  <Text style={styles.photoLabel}>Design sheet</Text>
                </View>
              ) : null}
            </View>
          </Section>
        ) : null}

        <Text style={styles.readOnlyFooter}>
          This order is read-only from here. Inspection, coding and job cards are
          handled by QA and the floor manager.
        </Text>
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
  vendor: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.slate },
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
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: 4 },
  cardTitle: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep, flexShrink: 1 },
  cardLine: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  totalLine: { marginTop: spacing.sm, fontSize: fontSize.secondary, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  body: { fontSize: fontSize.secondary, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  codeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  codeChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: colors.surface,
  },
  codeChipText: { fontFamily: fontFamily.mono, fontSize: fontSize.caption, color: colors.indigoDeep },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  photo: {
    width: 96,
    height: 96,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  photoLabel: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate, textAlign: 'center' },
  banner: { marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.md, borderWidth: 1 },
  readOnlyNote: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
  readOnlyFooter: {
    marginTop: spacing.sm,
    fontSize: fontSize.caption,
    color: colors.slate,
    fontStyle: 'italic',
    lineHeight: 18,
  },
});
