/**
 * Floor Manager: one order, three tabs.
 *
 *   Order Details — everyone and everything involved, and when
 *   Job Card      — build it, or open the one that exists
 *   Progress      — order-level and repeat-level status, toggled
 *
 * WHY THIS SCREEN EXISTS AT ALL: the floor manager used to land on
 * `OrderDetailScreen`, which is the ORDER TAKER's read-only tracker. It answers
 * "where is my order", which is the order taker's question. The floor manager's
 * questions are "who has it", "is the job card done" and "how far along is each
 * piece" — three different reads that were spread across three destinations.
 *
 * The Job Card tab does NOT re-implement the job card. It routes to the builder
 * or the detail screen depending on whether one exists, because those two
 * screens are the job card and a third copy of them would be a third thing to
 * keep correct.
 *
 * The Progress tab carries the granular status board (0090). Two views of ONE
 * derivation:
 *
 *   Order   — the full sequence for THIS order's stages, each row carrying a
 *             live count of how many repeats sit at exactly that status. An
 *             order is rarely at one status: six pieces can be in six places,
 *             and a single headline hides that.
 *   Repeats — every repeat and its exact position in that same sequence.
 *
 * Neither view records anything. Both are computed from `repeats.current_status`
 * + `current_stage_index` against the order's own `order_stages`, so the labels
 * ARE the existing Collection / Delivery / Pickup / Stage-QA mechanics, spelled
 * out — not a parallel tracker that can disagree with them.
 *
 * ONLY THE FLOOR MANAGER AND THE OWNER see this. The two RPCs behind it assert
 * that themselves; this screen is not the access control.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Image,
  Pressable,
  Modal,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { StitchLine } from '../../components/ui/StitchLine';
import { OrderStatusPill, StatusPill } from '../../components/ui/StatusPill';
import {
  getOrder,
  listSheets,
  listOrderStages,
  getJobCard,
  getOrderTimeline,
  getOrderPeople,
  getOrderStatusBoard,
  getRepeatStatusBoard,
  type OrderPersonRow,
  type OrderStatusRow,
  type RepeatStatusRow,
} from '../../api/endpoints/orders';
import { getPhotoUrls } from '../../api/endpoints/storage';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

type Tab = 'details' | 'job_card' | 'progress';
type ProgressView = 'order' | 'repeat';

const ROLE_ICON: Record<string, string> = {
  order_taker: 'person-outline',
  qa: 'shield-checkmark-outline',
  floor_manager: 'construct-outline',
  machine: 'cog-outline',
  delivery: 'bicycle-outline',
  finishing_partner: 'cut-outline',
};

function when(iso: string | null): string {
  if (!iso) return 'Not yet';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function FmOrderDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const orderId: string = route.params?.orderId;
  const [tab, setTab] = useState<Tab>('details');

  const order = useQuery({ queryKey: ['order', orderId], queryFn: () => getOrder(orderId) });
  const sheets = useQuery({ queryKey: ['sheets', orderId], queryFn: () => listSheets(orderId) });
  const stages = useQuery({
    queryKey: ['orderStages', orderId],
    queryFn: () => listOrderStages(orderId),
  });
  const jobCard = useQuery({ queryKey: ['jobCard', orderId], queryFn: () => getJobCard(orderId) });
  const people = useQuery({
    queryKey: ['orderPeople', orderId],
    queryFn: () => getOrderPeople(orderId),
  });
  const timeline = useQuery({
    queryKey: ['timeline', orderId],
    queryFn: () => getOrderTimeline(orderId),
  });
  const orderBoard = useQuery({
    queryKey: ['orderStatusBoard', orderId],
    queryFn: () => getOrderStatusBoard(orderId),
  });
  const repeatBoard = useQuery({
    queryKey: ['repeatStatusBoard', orderId],
    queryFn: () => getRepeatStatusBoard(orderId),
  });

  /**
   * One batched signed-URL call for every photo any of the three sources points
   * at. `createSignedUrls` takes a list; a board with a photo on each of a dozen
   * rows would otherwise fire a dozen round-trips every time the tab is opened.
   */
  const photoPaths = Array.from(
    new Set(
      [
        ...(timeline.data ?? []).map((x) => x.photo_url),
        ...(orderBoard.data ?? []).map((x) => x.photo_url),
        ...(repeatBoard.data ?? []).map((x) => x.photo_url),
      ].filter(Boolean) as string[]
    )
  );
  const photoUrls = useQuery({
    queryKey: ['orderBoardPhotos', orderId, photoPaths.join(',')],
    queryFn: () => getPhotoUrls(photoPaths),
    enabled: photoPaths.length > 0,
  });

  const totalRepeats = (sheets.data ?? []).reduce((n, s) => n + s.repeats_count, 0);

  if (order.isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }
  if (order.isError || !order.data) {
    return (
      <Screen>
        <Text style={styles.error}>{describeDbError(order.error, 'Order')}</Text>
      </Screen>
    );
  }

  const o = order.data;
  const card = jobCard.data?.card ?? null;

  return (
    <Screen padded={false}>
      <View style={styles.head}>
        <Text style={styles.code}>{o.order_code ?? '(draft)'}</Text>
        <OrderStatusPill status={o.status} />
      </View>
      <Text style={styles.vendor}>{o.vendors?.name ?? '—'}</Text>

      <SegmentedTabs
        value={tab}
        onChange={(k) => setTab(k as Tab)}
        tabs={[
          { key: 'details', label: 'Order Details' },
          { key: 'job_card', label: 'Job Card' },
          { key: 'progress', label: 'Progress' },
        ]}
      />

      {tab === 'details' ? (
        <DetailsTab
          totalRepeats={totalRepeats}
          colours={(sheets.data ?? []).length}
          people={people.data ?? []}
          loading={people.isLoading}
          error={people.error}
          onRefresh={() => {
            people.refetch();
            sheets.refetch();
          }}
          refreshing={people.isRefetching}
        />
      ) : null}

      {tab === 'job_card' ? (
        <JobCardTab
          hasCard={!!card}
          cardStatus={card?.status ?? null}
          lineCount={jobCard.data?.lines?.length ?? 0}
          stageCount={(stages.data ?? []).length}
          designCode={card?.design_code ?? null}
          onBuild={() => navigation.navigate('JobCardBuilder', { orderId })}
          onOpen={() => navigation.navigate('JobCard', { orderId })}
        />
      ) : null}

      {tab === 'progress' ? (
        <ProgressTab
          orderRows={orderBoard.data ?? []}
          repeatRows={repeatBoard.data ?? []}
          photoUrls={photoUrls.data ?? {}}
          loading={orderBoard.isLoading || repeatBoard.isLoading}
          error={orderBoard.error ?? repeatBoard.error}
          /* This board is a READ. The piece-by-piece actions (send to stage QA,
             hand over, confirm collection) live on Stage Tracking, and an order
             in production is exactly when they are wanted — so the way there is
             on this tab rather than instead of it. */
          onStageTracking={
            o.status === 'in_production' || o.status === 'in_finishing'
              ? () => navigation.navigate('StageTracking', { orderId })
              : undefined
          }
          onRefresh={() => {
            orderBoard.refetch();
            repeatBoard.refetch();
            timeline.refetch();
          }}
          refreshing={orderBoard.isRefetching || repeatBoard.isRefetching}
        />
      ) : null}
    </Screen>
  );
}

// ===========================================================================
// 1. Order Details
// ===========================================================================

function DetailsTab({
  totalRepeats,
  colours,
  people,
  loading,
  error,
  onRefresh,
  refreshing,
}: {
  totalRepeats: number;
  colours: number;
  people: OrderPersonRow[];
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  // Newest involvement last, so the list reads as the order's own history.
  const sorted = useMemo(
    () => [...people].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')),
    [people]
  );

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      <View style={styles.statRow}>
        <Stat label="Repeats" value={String(totalRepeats)} />
        <Stat label="Colours" value={String(colours)} />
      </View>

      <View style={styles.stitch}>
        <StitchLine />
      </View>

      <Text style={styles.sectionTitle}>Everyone involved</Text>
      {loading ? <ActivityIndicator color={colors.primary} /> : null}
      {error ? <Text style={styles.error}>{describeDbError(error, 'Order details')}</Text> : null}

      {!loading && sorted.length === 0 ? (
        <Text style={styles.empty}>
          Nobody has touched this order yet beyond the order taker who captured it.
        </Text>
      ) : null}

      {sorted.map((r, i) => (
        <View key={`${r.role_key}-${r.person}-${i}`} style={styles.personRow}>
          <View style={styles.personIcon}>
            <Ionicons
              name={(ROLE_ICON[r.role_key] ?? 'ellipse-outline') as any}
              size={18}
              color={colors.primary}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.personRole}>{r.role_label}</Text>
            <Text style={styles.personName} numberOfLines={1}>
              {r.person}
            </Text>
            {r.detail ? (
              <Text style={styles.personDetail} numberOfLines={2}>
                {r.detail}
              </Text>
            ) : null}
          </View>
          <Text style={styles.personWhen}>{when(r.at)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ===========================================================================
// 2. Job Card
// ===========================================================================

function JobCardTab({
  hasCard,
  cardStatus,
  lineCount,
  stageCount,
  designCode,
  onBuild,
  onOpen,
}: {
  hasCard: boolean;
  cardStatus: string | null;
  lineCount: number;
  stageCount: number;
  designCode: string | null;
  onBuild: () => void;
  onOpen: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {hasCard ? (
        <>
          <View style={styles.cardSummary}>
            <View style={styles.cardSummaryTop}>
              <Text style={styles.cardSummaryTitle}>Job card</Text>
              <StatusPill
                label={
                  cardStatus === 'confirmed'
                    ? 'Confirmed'
                    : cardStatus === 'shared'
                    ? 'Shared'
                    : 'Draft'
                }
                color={cardStatus === 'confirmed' ? colors.success : colors.accent}
              />
            </View>
            <Text style={styles.cardSummaryLine}>
              {designCode ? `Design ${designCode} · ` : ''}
              {lineCount} needle{lineCount === 1 ? '' : 's'} · {stageCount} stage
              {stageCount === 1 ? '' : 's'}
            </Text>
          </View>
          <AppButton title="Open job card" onPress={onOpen} />
        </>
      ) : (
        <>
          <Text style={styles.empty}>
            No job card yet. Building one sets the stage sequence, maps each needle to a thread
            colour, and records the design details.
          </Text>
          <AppButton title="Create job card" onPress={onBuild} />
        </>
      )}
    </ScrollView>
  );
}

// ===========================================================================
// 3. Progress
// ===========================================================================

function ProgressTab({
  orderRows,
  repeatRows,
  photoUrls,
  loading,
  error,
  onStageTracking,
  onRefresh,
  refreshing,
}: {
  orderRows: OrderStatusRow[];
  repeatRows: RepeatStatusRow[];
  photoUrls: Record<string, string>;
  loading: boolean;
  error: unknown;
  onStageTracking?: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [view, setView] = useState<ProgressView>('order');
  const [zoomed, setZoomed] = useState<string | null>(null);

  /**
   * Group the repeats by the status they are at, in the order-board's own
   * order. Two hundred repeat rows in code order is a list nobody reads; the
   * same rows under the status they share is the answer to "what is where".
   */
  const grouped = useMemo(() => {
    const order = new Map(orderRows.map((r, i) => [r.step_key, i]));
    const byKey = new Map<string, { label: string; rows: RepeatStatusRow[] }>();
    for (const r of repeatRows) {
      const g = byKey.get(r.status_key);
      if (g) g.rows.push(r);
      else byKey.set(r.status_key, { label: r.status_label, rows: [r] });
    }
    return [...byKey.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
  }, [orderRows, repeatRows]);

  const totalRepeats = repeatRows.length;

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <SegmentedTabs
          value={view}
          onChange={(k) => setView(k as ProgressView)}
          tabs={[
            { key: 'order', label: 'Order' },
            { key: 'repeat', label: `Repeats${totalRepeats ? ` (${totalRepeats})` : ''}` },
          ]}
        />

        {onStageTracking ? (
          <AppButton
            title="Open stage tracking"
            variant="secondary"
            size="sm"
            icon="layers-outline"
            onPress={onStageTracking}
            style={{ marginTop: spacing.md }}
          />
        ) : null}

        {loading ? <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} /> : null}
        {error ? (
          <Text style={styles.error}>{describeDbError(error, 'Status board')}</Text>
        ) : null}

        {view === 'order' ? (
          <View style={styles.progressBody}>
            {orderRows.map((r) => (
              <BoardRow
                key={r.step_key}
                row={r}
                url={r.photo_url ? photoUrls[r.photo_url] : undefined}
                onZoom={setZoomed}
              />
            ))}
            {/* Only claim "nothing recorded" when the read actually succeeded —
                an error plus an empty-state reads as two different answers to
                the same question. */}
            {!loading && !error && orderRows.length === 0 ? (
              <Text style={styles.empty}>No status recorded for this order yet.</Text>
            ) : null}
          </View>
        ) : (
          <View style={styles.progressBody}>
            {grouped.map((g) => (
              <View key={g.key} style={styles.group}>
                <View style={styles.groupHead}>
                  <Text style={styles.groupLabel}>{g.label}</Text>
                  <View style={styles.countPill}>
                    <Text style={styles.countPillText}>{g.rows.length}</Text>
                  </View>
                </View>
                {g.rows.map((r) => (
                  <RepeatRow
                    key={r.repeat_id}
                    row={r}
                    url={r.photo_url ? photoUrls[r.photo_url] : undefined}
                    onZoom={setZoomed}
                  />
                ))}
              </View>
            ))}
            {!loading && !error && grouped.length === 0 ? (
              <Text style={styles.empty}>
                No repeats coded yet — QA codes each piece as it passes inspection.
              </Text>
            ) : null}
          </View>
        )}
      </ScrollView>

      <Modal
        visible={!!zoomed}
        transparent
        animationType="fade"
        onRequestClose={() => setZoomed(null)}
      >
        <Pressable
          style={styles.zoomScrim}
          accessibilityRole="button"
          accessibilityLabel="Close photo"
          onPress={() => setZoomed(null)}
        >
          {zoomed ? <Image source={{ uri: zoomed }} style={styles.zoomImage} resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </>
  );
}

/** One row of the order-level board: a status, its live count, its evidence. */
function BoardRow({
  row,
  url,
  onZoom,
}: {
  row: OrderStatusRow;
  url?: string;
  onZoom: (u: string) => void;
}) {
  const active = row.kind === 'stage' ? (row.count ?? 0) > 0 : row.state === 'current';
  const done = row.kind === 'milestone' && row.state === 'done';

  return (
    <View style={[styles.boardRow, active && styles.boardRowActive]}>
      <View style={styles.boardRail}>
        <View
          style={[
            styles.boardDot,
            done && styles.boardDotDone,
            active && styles.boardDotActive,
          ]}
        >
          {done ? <Ionicons name="checkmark" size={11} color={colors.white} /> : null}
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.boardLabel, active && styles.boardLabelActive]}>{row.label}</Text>
        {row.at ? <Text style={styles.boardMeta}>{when(row.at)}</Text> : null}
      </View>

      {url ? (
        <Pressable
          onPress={() => onZoom(url)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${row.label} photo — tap to enlarge`}
          style={({ pressed }) => [styles.thumbWrap, pressed && { opacity: 0.8 }]}
        >
          <Image source={{ uri: url }} style={styles.thumb} resizeMode="cover" />
        </Pressable>
      ) : null}

      {/* A count is only meaningful on a stage row. Milestones are order-wide,
          and a "0" beside "Job Card Approved" would read as a failure. */}
      {row.kind === 'stage' ? (
        <View style={[styles.countPill, (row.count ?? 0) === 0 && styles.countPillZero]}>
          <Text style={[styles.countPillText, (row.count ?? 0) === 0 && styles.countPillTextZero]}>
            {row.count ?? 0}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One repeat, under the status it currently sits at. */
function RepeatRow({
  row,
  url,
  onZoom,
}: {
  row: RepeatStatusRow;
  url?: string;
  onZoom: (u: string) => void;
}) {
  return (
    <View style={[styles.repeatRow, row.sla_breached && styles.repeatRowLate]}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={styles.repeatCode}>{row.repeat_code}</Text>
        <Text style={styles.repeatMeta} numberOfLines={1}>
          {row.partner_name ? `${row.partner_name} · ` : ''}
          {when(row.at)}
        </Text>
      </View>
      {row.sla_breached ? <StatusPill label="Past SLA" color={colors.alert} /> : null}
      {url ? (
        <Pressable
          onPress={() => onZoom(url)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${row.repeat_code} photo — tap to enlarge`}
          style={({ pressed }) => [styles.thumbWrap, pressed && { opacity: 0.8 }]}
        >
          <Image source={{ uri: url }} style={styles.thumb} resizeMode="cover" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.title,
    color: colors.ink,
    fontWeight: fontWeight.semibold,
  },
  vendor: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
    fontSize: fontSize.body,
    color: colors.ink,
  },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },

  statRow: { flexDirection: 'row', gap: spacing.md },
  stat: {
    flex: 1,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  statValue: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  statLabel: { marginTop: 2, fontSize: fontSize.caption, color: colors.inkMuted },
  stitch: { marginVertical: spacing.lg },

  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
  },
  personIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.tintTeal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personRole: {
    fontSize: fontSize.caption,
    color: colors.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  personName: {
    marginTop: 1,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    color: colors.ink,
  },
  personDetail: { marginTop: 2, fontSize: fontSize.caption, color: colors.inkMuted },
  personWhen: { fontSize: fontSize.caption, color: colors.inkSubtle, textAlign: 'right', maxWidth: 110 },

  cardSummary: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: spacing.lg,
  },
  cardSummaryTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardSummaryTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  cardSummaryLine: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.inkMuted },

  progressBody: { marginTop: spacing.lg },

  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingRight: spacing.sm,
  },
  boardRowActive: {
    backgroundColor: colors.tintTeal,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
  },
  boardRail: { width: 18, alignItems: 'center' },
  boardDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardDotDone: { backgroundColor: colors.success, borderColor: colors.success },
  boardDotActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  boardLabel: { fontSize: fontSize.secondary, color: colors.inkMuted },
  boardLabelActive: { color: colors.ink, fontWeight: fontWeight.semibold },
  boardMeta: { marginTop: 1, fontSize: fontSize.caption, color: colors.inkSubtle },

  countPill: {
    minWidth: 26,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  countPillZero: { backgroundColor: colors.border },
  countPillText: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  countPillTextZero: { color: colors.inkSubtle },

  group: { marginBottom: spacing.lg },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  groupLabel: {
    flex: 1,
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },

  thumbWrap: {
    width: 44,
    height: 34,
    borderRadius: radius.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  thumb: { width: '100%', height: '100%' },
  zoomScrim: {
    flex: 1,
    backgroundColor: 'rgba(27, 46, 45, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  zoomImage: { width: '100%', height: '80%' },

  repeatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
  },
  repeatRowLate: { borderColor: colors.alert },
  repeatCode: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.secondary,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  repeatMeta: { fontSize: fontSize.caption, color: colors.inkMuted },

  empty: {
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  error: { fontSize: fontSize.secondary, color: colors.alert, marginBottom: spacing.sm },
});

export default FmOrderDetailScreen;
