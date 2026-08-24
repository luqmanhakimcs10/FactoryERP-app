/**
 * Delivery Person — TWO action tabs: Delivery and Pickup. (0092)
 *
 * WHAT THIS REPLACES
 * ------------------
 * Collection / Delivery / Pickup, which was three tabs for a round trip with
 * two halves. The Collection tab existed because the Floor Manager's handover
 * and the delivery person's collection were two separate presses recording one
 * moment — two people standing next to each other, each confirming the same
 * transfer. The same duplication sat at the other end of the trip, where the
 * piece was "handed back" and then "collected" by the floor.
 *
 * Both are gone. The Floor Manager's handover puts the piece straight into this
 * screen's Delivery tab, and the drop-off at the Inspector is what advances the
 * stage. What is left is the two things this role actually does.
 *
 * THE FOUR STATUSES, AND WHY TWO TABS HOLD THEM
 * ---------------------------------------------
 *   1. Delivery    handed_over          -> take it to the finishing partner
 *   2. In Pickup   handed_off           at the partner. Nothing to do.
 *   3. Pickup      handed_off           -> collect it back
 *   4. Delivery    returned_to_delivery -> take it to the Inspector
 *      Completion  stage_qa             done. Read-only.
 *
 * 2 and 3 are the SAME database row seen twice, which is the whole shape of
 * this screen: "In Pickup" is what the piece IS, and the Pickup tab is where
 * you go to do something about it. There is no third state in between, because
 * THE PARTNER PRESSES NOTHING — they do the physical work and hand the piece
 * back when the delivery person turns up. Waiting for a partner-side button
 * before showing the row would be waiting for something nobody sends.
 *
 * 1 and 4 are the same ACTION — drop something off, with a photo — in opposite
 * directions, which is why one tab holds both. `destination_kind` on the row
 * says where, so the button can name it.
 *
 * WHICH TAB A ROW SITS IN IS DECIDED IN SQL, not here — `dp_orders_queue`
 * returns it. Which tab a status belongs to is part of the workflow definition,
 * and a client that works it out for itself can file a piece under a tab whose
 * action the database will then refuse.
 *
 * EMBROIDERY IS NEVER HERE. It runs in-house on the factory's own machines, so
 * the first time this role is involved at all is the handover that FOLLOWS it.
 * Nothing filters it out: an in-house stage never reaches a status this queue
 * selects, which is a stronger guarantee than a filter would be.
 *
 * THE PARTNER IS NOT CHOSEN HERE. The Floor Manager names both the delivery
 * person and the finishing partner when they hand over (0084), so the Delivery
 * tab shows the destination rather than asking for it. The one exception is a
 * piece handed over by a pre-0084 client, which carries no partner; those — and
 * only those — still get a picker.
 *
 * SLA-breached rows sort to the top of whichever tab they are in and carry an
 * alert pill.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable, RefreshControl } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { MetricCard, MetricRow, MetricsSection } from '../../components/ui/MetricCard';
import { statCount } from '../../utils/statValue';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { AppButton } from '../../components/ui/AppButton';
import { StatusPill, RepeatStatusPill } from '../../components/ui/StatusPill';
import { EmptyState, ListSkeleton } from '../../components/ui/States';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { SelectField } from '../../components/forms/SelectField';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { listLinkedOptions } from '../../api/endpoints/masters';
import { listFinalDeliveryQueue } from '../../api/endpoints/finishing';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import {
  listDeliveryOrders,
  handoverToPartner,
  collectFromPartner,
  deliverToQa,
  DELIVERY_TABS,
  type DpOrderRow,
  type DeliveryTab,
} from '../../api/endpoints/stageHandover';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  elevation,
  tint,
} from '../../constants/theme';

/** Human wording for a stage, e.g. "clipping" -> "Clipping". */
function stageLabel(stage: string | null | undefined) {
  if (!stage) return 'this stage';
  const words = stage.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "3 days", "6h" — how long a piece has been sitting where it is. */
function elapsed(since: string | null | undefined): string | null {
  if (!since) return null;
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)} days`;
}

const TAB_COPY: Record<DeliveryTab, { title: string; blurb: string; empty: string }> = {
  delivery: {
    title: 'Delivery',
    blurb: 'In your hands, waiting to be dropped off — at a partner or at the Inspector.',
    empty: 'A piece lands here the moment the Floor Manager hands one to you.',
  },
  pickup: {
    title: 'Pickup',
    blurb: 'Out at a finishing partner. Collect each one back when their work is done.',
    empty: 'Pieces appear here once you have delivered them to a partner.',
  },
  completion: {
    title: 'Completion',
    blurb: 'Delivered to the Inspector. Your part of this stage is finished.',
    empty: 'Nothing delivered to the Inspector yet.',
  },
};

export function DeliveryOrdersScreen({ navigation, route }: any) {
  const [search, setSearch] = useState('');
  // A task banner deep-links to the tab that actually holds its rows, the same
  // way the Floor Manager's accept-inventory banner opens its tab. This
  // initialiser covers the cold case — the screen mounting with a tab already
  // named on the route...
  const [tab, setTab] = useState<DeliveryTab>((route?.params?.tab as DeliveryTab) ?? 'delivery');
  const [openId, setOpenId] = useState<string | null>(null);

  // ...but the initialiser alone is why the banner was a dead click.
  //
  // Every OTHER role's banner opens a DIFFERENT screen (TaskQueue, OrdersBox,
  // StageTracking), which mounts fresh and reads its params on the way up. This
  // role's banners are rendered BY this screen and point back at it: RoleHome
  // *is* DeliveryOrdersScreen. So `navigate('RoleHome', { tab: 'delivery' })`
  // targets the route that is already mounted and focused — React Navigation
  // updates `route.params` and stops there. No remount, so the useState
  // initialiser above never runs again and the tab never moved. The tap was
  // firing and navigating correctly the whole time; it simply had nowhere new
  // to go, which is exactly what "nothing happens" looks like.
  //
  // The param is CONSUMED once applied. Without that, a second tap on the same
  // banner writes the same value, the dependency below never changes, the
  // effect never re-runs, and the banner is dead again the moment the user
  // switches tab by hand.
  useEffect(() => {
    const wanted = route?.params?.tab as DeliveryTab | undefined;
    if (!wanted) return;
    setTab(wanted);
    setOpenId(null);
    navigation.setParams({ tab: undefined });
  }, [route?.params?.tab, navigation]);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['dpOrders'],
    queryFn: listDeliveryOrders,
  });

  // The final handover to the CLIENT. It is not one of the stage-loop journeys,
  // so it is not a tab; it sits under Delivery, which is the tab whose meaning
  // it shares — a piece leaving this building for somewhere else.
  const { data: finalDeliveries } = useQuery({
    queryKey: ['dpFinalDelivery'],
    queryFn: listFinalDeliveryQueue,
  });

  const matches = (r: DpOrderRow) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      r.repeat_code.toLowerCase().includes(q) ||
      (r.order_code ?? '').toLowerCase().includes(q) ||
      (r.vendor_name ?? '').toLowerCase().includes(q) ||
      (r.stage_type ?? '').toLowerCase().includes(q) ||
      (r.destination_stage ?? '').toLowerCase().includes(q) ||
      (r.partner_name ?? '').toLowerCase().includes(q)
    );
  };

  const all = (data ?? []).filter(matches);
  const counts: Record<DeliveryTab, number> = {
    delivery: all.filter((r) => r.tab === 'delivery').length,
    pickup: all.filter((r) => r.tab === 'pickup').length,
    completion: all.filter((r) => r.tab === 'completion').length,
  };
  const rows = all.filter((r) => r.tab === tab);
  /*
   * The metrics grid IS `counts` — the same numbers the tab labels carry.
   * Deliberately not a second read: two sources for "how many am I delivering"
   * is two numbers that can disagree on the same screen.
   *
   * There are THREE cards and TWO tabs, on purpose. Completion is a status, not
   * a tab — there is nothing to do on those rows — but it is the last leg of
   * this role's job and it should be countable. Tapping it opens the read-only
   * list rather than a fourth place to press something.
   */
  const breached = rows.filter((r) => r.sla_breached).length;
  const showFinal = tab === 'delivery' && (finalDeliveries?.length ?? 0) > 0;

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Repeat, order, vendor, stage…"
        navigation={navigation}
      />

      <View style={styles.metrics}>
        <MetricsSection subtitle="What is in your hands right now">
          <MetricRow>
            <MetricCard
              label="In Delivery"
              value={statCount(isLoading ? undefined : counts.delivery)}
              icon="bicycle-outline"
              accent={counts.delivery ? 'amber' : 'teal'}
              onPress={() => setTab('delivery')}
            />
            <MetricCard
              label="In Pickup"
              value={statCount(isLoading ? undefined : counts.pickup)}
              icon="cube-outline"
              accent={counts.pickup ? 'rose' : 'teal'}
              onPress={() => setTab('pickup')}
            />
            <MetricCard
              label="Completion"
              value={statCount(isLoading ? undefined : counts.completion)}
              icon="checkmark-done-outline"
              accent={counts.completion ? 'green' : 'teal'}
              onPress={() => setTab('completion')}
            />
          </MetricRow>
        </MetricsSection>
      </View>

      <View style={styles.tabsWrap}>
        {/* `completion` matches no tab, so neither segment is highlighted while
            the read-only list is open. Highlighting Delivery there would claim
            the user is looking at something they are not. */}
        <SegmentedTabs
          value={tab}
          onChange={(k) => {
            setTab(k as DeliveryTab);
            setOpenId(null);
          }}
          tabs={DELIVERY_TABS.map((k) => ({
            key: k,
            label: `${TAB_COPY[k].title}${counts[k] ? ` (${counts[k]})` : ''}`,
          }))}
        />
      </View>

      <View style={styles.head}>
        <Text style={styles.sub}>
          {TAB_COPY[tab].blurb}
          {breached > 0 ? ` · ${breached} past SLA` : ''}
        </Text>
        {/* Completion has no tab of its own, so reaching it via the metric card
            leaves both segments unselected. Say where you are rather than let
            the header quietly contradict the control above it. */}
        {tab === 'completion' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setTab('delivery')}
            style={styles.backToTabs}
          >
            <Ionicons name="arrow-back" size={14} color={colors.primary} />
            <Text style={styles.backToTabsText}>Back to Delivery</Text>
          </Pressable>
        ) : null}
        <View style={styles.stitch} />
      </View>

      {/* The stage-loop banners are exactly these tabs, which are right above
          with the same counts on them. Rendering both stacked banners over the
          list and pushed every row off the bottom of the screen, so every tab
          showed the same thing and switching looked broken. "Ready for final
          delivery" stays — it has no tab. */}
      <View style={styles.banner}>
        <TaskBanners hideQueues={['dp_deliver', 'dp_pickup']} />
      </View>

      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.repeat_id}
          contentContainerStyle={{ paddingBottom: spacing.xxl }}
          // Same react-native-web virtualisation trap as the Floor Manager's
          // order list: the windowing pass never advanced, so only the first
          // ~10 rows ever rendered and the rest were unreachable by scrolling.
          // This list is tens of rows, not thousands.
          initialNumToRender={rows.length || 20}
          windowSize={21}
          removeClippedSubviews={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            !showFinal ? (
              <EmptyState
                icon="cube-outline"
                title={`Nothing in ${TAB_COPY[tab].title.toLowerCase()}`}
                message={TAB_COPY[tab].empty}
              />
            ) : null
          }
          renderItem={({ item }) => (
            <DeliveryCard
              row={item}
              expanded={openId === item.repeat_id}
              onToggle={() => setOpenId(openId === item.repeat_id ? null : item.repeat_id)}
            />
          )}
          ListFooterComponent={
            showFinal ? (
              <View style={styles.footer}>
                <Text style={styles.sectionTitle}>Ready for final delivery</Text>
                <Text style={styles.sectionSub}>
                  Every stage is through QA. These go back to the client.
                </Text>
                {(finalDeliveries ?? []).map((d) => (
                  <Pressable
                    key={d.order_id}
                    accessibilityRole="button"
                    onPress={() => navigation.navigate('FinalDelivery', { item: d })}
                    style={({ pressed }) => [styles.card, styles.finalCard, pressed && { opacity: 0.85 }]}
                  >
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={styles.code}>{d.order_code}</Text>
                      <Text style={styles.meta}>
                        {d.vendor_name} · {d.completed_repeats}/{d.total_repeats} pieces
                      </Text>
                      <View style={styles.pills}>
                        <StatusPill label="Ready for delivery" color={colors.progressDone} />
                      </View>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.slate} />
                  </Pressable>
                ))}
              </View>
            ) : null
          }
        />
      )}
    </Screen>
  );
}

function DeliveryCard({
  row,
  expanded,
  onToggle,
}: {
  row: DpOrderRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const [photo, setPhoto] = useState<LocalPhoto[]>([]);
  const [partnerId, setPartnerId] = useState<string | null>(row.partner_id);
  const [error, setError] = useState<string | null>(null);

  // Completion rows are the record of a finished leg. Every OTHER row has
  // exactly one action and it always takes a photo — that uniformity is the
  // point of the two-tab shape.
  const isCompletion = row.tab === 'completion';
  /*
   * WHICH STAGE THIS TRIP IS ABOUT.
   *
   * `current_stage_index` is the stage the piece has last CLEARED, and it does
   * not advance until the piece reaches the Inspector — so through the whole
   * out-and-back trip `stage_type` still reads "embroidery" while the work
   * being done is clipping. `destination_stage` is the stage the trip is FOR,
   * which is the one worth naming on every row except a completion row, where
   * the index has already moved and `stage_type` is the partner's own stage.
   *
   * Getting this backwards is how a row ends up telling the delivery person to
   * collect embroidery from a clipping partner.
   */
  const workStage = isCompletion ? row.stage_type : row.destination_stage ?? row.stage_type;
  const workSequence = isCompletion ? row.stage_sequence : (row.stage_sequence ?? 0) + 1;
  // Only a piece handed over before 0084 arrives with no partner set.
  const needsPartnerPick = row.current_status === 'handed_over' && !row.partner_id;
  /** Where this trip is going. From SQL — see `destination_kind`. */
  const toQa = row.destination_kind === 'qa';

  const { data: partners, isLoading: partnersLoading } = useQuery({
    queryKey: ['finishingPartnerOptions', 'any'],
    queryFn: () => listLinkedOptions('finishing_partners', 'name'),
    enabled: needsPartnerPick && expanded,
  });

  function done() {
    setPhoto([]);
    setError(null);
    queryClient.invalidateQueries({ queryKey: ['dpOrders'] });
    queryClient.invalidateQueries({ queryKey: ['repeats', row.order_id] });
    // Every leg here changes what another role is waiting on, so their bells
    // and boards have to learn about it too.
    queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
    queryClient.invalidateQueries({ queryKey: ['partner', 'activeWork'] });
  }

  const act = useMutation({
    mutationFn: async () => {
      // The upload runs first on every leg: each RPC rejects an empty url, so a
      // failed upload must surface as an upload error rather than as a
      // confusing database refusal about a photo the user did take.
      const url = await uploadOrderPhoto(profile?.factory_id ?? '', row.order_id, photo[0].uri);
      if (row.current_status === 'handed_over') return handoverToPartner(row.repeat_id, url, partnerId);
      if (row.current_status === 'handed_off') return collectFromPartner(row.repeat_id, url);
      return deliverToQa(row.repeat_id, url);
    },
    onSuccess: done,
    onError: (e) => setError(describeDbError(e, 'Delivery')),
  });

  const actionLabel =
    row.current_status === 'handed_over'
      ? `Deliver to ${row.partner_name ?? 'finishing partner'}`
      : row.current_status === 'handed_off'
        ? `Collect from ${row.partner_name ?? 'partner'}`
        : 'Deliver to the Inspector';

  const photoLabel =
    row.current_status === 'handed_over'
      ? `Photo of the piece as handed to ${row.partner_name ?? 'the partner'}`
      : row.current_status === 'handed_off'
        ? `Photo of the piece as collected back from ${row.partner_name ?? 'the partner'}`
        : 'Photo of the piece as handed to the Inspector';

  const canAct = photo.length > 0 && (!needsPartnerPick || !!partnerId);
  const atPartnerFor = elapsed(row.handed_off_at);

  return (
    <View style={[styles.card, row.sla_breached && styles.cardBreached]}>
      <Pressable onPress={onToggle} accessibilityRole="button" style={styles.cardHead}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.code}>{row.repeat_code}</Text>
          <Text style={styles.meta}>
            {row.order_code} · {row.vendor_name}
          </Text>
          <Text style={styles.meta}>
            Stage {workSequence ?? '—'} of {row.total_stages} · {stageLabel(workStage)}
          </Text>
          {row.partner_name ? <Text style={styles.meta}>Partner: {row.partner_name}</Text> : null}
          <View style={styles.pills}>
            <RepeatStatusPill status={row.current_status} perspective="delivery" />
            {row.sla_breached ? <StatusPill label="SLA breached" color={colors.alert} /> : null}
            {/* How long it has been out. The partner tells the app nothing —
                they press no button at all — so time-at-partner and the SLA are
                what the delivery person has to judge by, and they are on the
                collapsed row rather than hidden behind a tap. */}
            {row.current_status === 'handed_off' && atPartnerFor ? (
              <StatusPill
                label={`At partner ${atPartnerFor}`}
                color={row.sla_breached ? colors.alert : colors.progressActive}
              />
            ) : null}
          </View>
        </View>
        <View style={styles.chev}>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.slate} />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          {isCompletion ? (
            <Text style={styles.note}>
              Delivered to the Inspector. The {stageLabel(workStage).toLowerCase()} work is being
              checked now — once it passes, the Floor Manager gets the next handover. There is
              nothing for you to do on this piece.
            </Text>
          ) : (
            <>
              <PhotoPicker
                label={photoLabel}
                hint="Required — this is the proof of physical custody."
                photos={photo}
                onChange={setPhoto}
                multiple={false}
                retakeLabel="Retake"
              />

              {needsPartnerPick ? (
                <>
                  <Text style={styles.note}>
                    This piece was handed over before the Floor Manager began naming the partner,
                    so there is no destination on it. Pick one to send it out.
                  </Text>
                  <SelectField
                    label="Finishing partner"
                    value={partnerId}
                    onChange={setPartnerId}
                    options={partners ?? []}
                    loading={partnersLoading}
                    required
                    emptyHint="No finishing partners on file yet — add one under Master data."
                  />
                </>
              ) : null}

              {toQa && row.current_status === 'returned_to_delivery' ? (
                <Text style={styles.note}>
                  This is the last leg of your job on this stage. Handing it to the Inspector puts
                  the {stageLabel(workStage).toLowerCase()} work straight into Stage QA — the Floor
                  Manager does not have to confirm anything first.
                </Text>
              ) : null}

              {row.current_status === 'handed_off' ? (
                <Text style={styles.note}>
                  {atPartnerFor
                    ? `With ${row.partner_name ?? 'the partner'} for ${atPartnerFor}.`
                    : `With ${row.partner_name ?? 'the partner'}.`}
                  {row.sla_hours ? ` SLA is ${row.sla_hours}h from handover.` : ''}
                  {row.sla_breached ? ' This one is already past it.' : ''}
                  {' Collect it whenever the work is actually done — the partner has nothing to '}
                  {'press to release it.'}
                </Text>
              ) : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <AppButton
                title={actionLabel}
                variant="brass"
                disabled={!canAct}
                loading={act.isPending}
                onPress={() => {
                  setError(null);
                  act.mutate();
                }}
              />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  metrics: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  tabsWrap: { paddingTop: spacing.md },
  head: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  sub: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  backToTabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    minHeight: 32,
  },
  backToTabsText: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
  },
  // The stitch line: the app's running motif for "a seam between steps".
  stitch: {
    marginTop: spacing.md,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: colors.brass,
    opacity: 0.5,
  },
  banner: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.sm,
  },
  cardBreached: { borderColor: colors.alert, backgroundColor: tint(colors.alert, 0.04) },
  cardHead: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  chev: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: tint(colors.slate, 0.1),
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.lg,
    gap: spacing.sm,
  },
  note: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 18, marginBottom: spacing.xs },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.xs },
  footer: { marginTop: spacing.xl },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  sectionSub: {
    paddingHorizontal: spacing.lg,
    marginTop: 2,
    fontSize: fontSize.caption,
    color: colors.slate,
  },
  finalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderColor: colors.progressDone,
  },
});

export default DeliveryOrdersScreen;
