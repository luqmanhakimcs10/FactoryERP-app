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
  /**
   * Signed URLs for every photo this screen shows — the order's own strip AND
   * the one attached to each timeline step (0087).
   *
   * Resolved in ONE batched call rather than per step: `createSignedUrls` takes
   * a list, and a timeline with eight stages would otherwise fire eight
   * round-trips every time the screen mounts.
   */
  const timelinePaths = (timeline ?? [])
    .map((t) => t.photo_url)
    .filter(Boolean) as string[];

  const { data: photoUrls } = useQuery({
    queryKey: [
      'orderPhotos',
      orderId,
      order?.cloth_photos?.length,
      order?.design_sheet_url,
      timelinePaths.join(','),
    ],
    queryFn: () =>
      getPhotoUrls(
        // De-duplicated: the cloth photo is both the order's own and the
        // "Order captured" step's, and asking for the same path twice wastes a
        // slot in a request that is already the widest one on this screen.
        Array.from(
          new Set(
            [
              ...(order?.cloth_photos ?? []),
              order?.design_sheet_url,
              ...timelinePaths,
            ].filter(Boolean) as string[]
          )
        )
      ),
    enabled: !!order,
  });

  const totalRepeats = (sheets ?? []).reduce((n, s) => n + s.repeats_count, 0);

  /**
   * One line per colour, with that colour's repeats added up across its sheets.
   *
   * ABOVE the loading/error early returns on purpose: it is a hook, and a hook
   * that only runs on some renders is a hooks-order violation — React bails out
   * of the whole screen with "rendered more hooks than during the previous
   * render" the moment the query resolves.
   */
  const byColor = React.useMemo(() => {
    const map = new Map<
      string,
      { color: string; repeats: number; stitchCount: number; threads: string[] }
    >();
    for (const s of sheets ?? []) {
      const key = s.color_assignment ?? '—';
      const cur = map.get(key);
      if (cur) {
        cur.repeats += s.repeats_count;
        for (const t of s.thread_color_codes) if (!cur.threads.includes(t)) cur.threads.push(t);
      } else {
        map.set(key, {
          color: key,
          repeats: s.repeats_count,
          stitchCount: s.stitch_count,
          threads: [...s.thread_color_codes],
        });
      }
    }
    return [...map.values()];
  }, [sheets]);

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
            <StageProgress
              steps={timeline}
              orientation="vertical"
              photoUrls={photoUrls ?? {}}
            />
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

        {/* ---- Repeats, by colour ----
            Grouped by colour rather than listed per sheet: `sheets` is the row
            shape the database needs, not a quantity the order taker ordered or
            can act on, and showing both counts side by side was the confusion
            this section is fixing. Two sheets of the same colour are one line
            here with their repeats added together. */}
        <Section title={`Repeats (${totalRepeats})`}>
          {byColor.map((c) => (
            <View key={c.color} style={styles.card}>
              <Text style={styles.cardTitle}>{c.color}</Text>
              <Text style={styles.cardLine}>
                <Text style={styles.mono}>{c.repeats}</Text> repeat{c.repeats === 1 ? '' : 's'}
                {c.stitchCount > 0 ? (
                  <>
                    {' · '}
                    <Text style={styles.mono}>{c.stitchCount.toLocaleString()}</Text> stitches each
                  </>
                ) : null}
              </Text>
              <Text style={styles.cardLine}>
                Threads: <Text style={styles.mono}>{c.threads.join(', ') || '—'}</Text>
              </Text>
            </View>
          ))}
          <Text style={styles.totalLine}>
            Total: <Text style={styles.mono}>{totalRepeats}</Text> repeat
            {totalRepeats === 1 ? '' : 's'}
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
                  {d.sheets ? ` · ${d.sheets.color_assignment}` : ''}
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
