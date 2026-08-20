/**
 * Delivery Person — THREE tabs: Collection, Delivery, Pickup. (0084, Fix 5)
 *
 * WHAT THIS REPLACES
 * A single "Orders" list holding all four legs at once, with the action derived
 * from each row's status. That was an improvement on the Handoff/Return/SLA
 * split it replaced, but it flattened a round trip into a heap: a piece being
 * carried out and a piece being fetched back look identical in it, and the one
 * question this role actually asks — "what am I picking up right now?" — had no
 * answer short of reading every pill.
 *
 * The three tabs are the three physical journeys, in order:
 *
 *   Collection  Pieces the Floor Manager handed to ME. Collect (photo) — the
 *               piece is now in my hands.
 *   Delivery    Pieces I am carrying out to a finishing partner. Handover
 *               (photo) — custody passes to them and the SLA clock starts.
 *   Pickup      The return leg. Collect back from the partner (photo), then
 *               return it to the Floor Manager, who puts it through Stage QA.
 *
 * WHICH TAB A ROW SITS IN IS DECIDED IN SQL, not here — `dp_orders_queue`
 * returns it. Which tab a status belongs to is part of the workflow definition,
 * and a client that works it out for itself can file a piece under a tab whose
 * action the database will then refuse.
 *
 * THE PARTNER IS NO LONGER CHOSEN HERE. The Floor Manager names both the
 * delivery person and the finishing partner when they hand over (Fix 4), so the
 * Delivery tab shows the destination rather than asking for it. The one
 * exception is a piece handed over by a pre-0084 client, which carries no
 * partner; those — and only those — still get a picker.
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
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
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
  collectFromFloor,
  handoverToPartner,
  collectFromPartner,
  handBackToFloor,
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

const TAB_COPY: Record<DeliveryTab, { title: string; blurb: string; empty: string }> = {
  collection: {
    title: 'Collection',
    blurb: 'Handed to you by the Floor Manager. Photograph each piece as you take it.',
    empty: 'Pieces appear here the moment a Floor Manager hands one to you.',
  },
  delivery: {
    title: 'Delivery',
    blurb: 'In your hands, on the way to a finishing partner.',
    empty: 'Anything you collect from the floor lands here, ready to go out.',
  },
  pickup: {
    title: 'Pickup',
    blurb: 'Out at a partner, or collected back and due at the floor.',
    empty: 'Pieces appear here once they are with a partner and on their way back.',
  },
};

export function DeliveryOrdersScreen({ navigation, route }: any) {
  const [search, setSearch] = useState('');
  // A task banner deep-links to the tab that actually holds its rows, the same
  // way the Floor Manager's accept-inventory banner opens its tab. This
  // initialiser covers the cold case — the screen mounting with a tab already
  // named on the route...
  const [tab, setTab] = useState<DeliveryTab>(
    (route?.params?.tab as DeliveryTab) ?? 'collection'
  );
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

  // The final handover to the CLIENT. It is not one of the three stage-loop
  // journeys, so it is not a tab; it sits under Delivery, which is the tab whose
  // meaning it shares — a piece leaving this building for somewhere else.
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
    collection: all.filter((r) => r.tab === 'collection').length,
    delivery: all.filter((r) => r.tab === 'delivery').length,
    pickup: all.filter((r) => r.tab === 'pickup').length,
  };
  const rows = all.filter((r) => r.tab === tab);
  /*
   * The metrics grid IS `counts` — the same three numbers the tab labels carry.
   * Deliberately not a second read: two sources for "how many am I collecting"
   * is two numbers that can disagree on the same screen.
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
        <StatGrid>
          <StatCard
            label="In Collection"
            value={statCount(isLoading ? undefined : counts.collection)}
            icon="download-outline"
            tone={counts.collection ? 'attention' : 'neutral'}
            onPress={() => setTab('collection')}
          />
          <StatCard
            label="In Delivery"
            value={statCount(isLoading ? undefined : counts.delivery)}
            icon="bicycle-outline"
            tone={counts.delivery ? 'attention' : 'neutral'}
            onPress={() => setTab('delivery')}
          />
          <StatCard
            label="In Pickup"
            value={statCount(isLoading ? undefined : counts.pickup)}
            icon="cube-outline"
            tone={counts.pickup ? 'attention' : 'neutral'}
            onPress={() => setTab('pickup')}
          />
        </StatGrid>
      </View>

      <View style={styles.tabsWrap}>
        <SegmentedTabs
          value={tab}
          onChange={(k) => {
            setTab(k as DeliveryTab);
            setOpenId(null);
          }}
          tabs={(['collection', 'delivery', 'pickup'] as DeliveryTab[]).map((k) => ({
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
        <View style={styles.stitch} />
      </View>

      {/* The four stage-loop banners are exactly these three tabs, which are
          right above with the same counts on them. Rendering both stacked five
          banners over the list and pushed every row off the bottom of the
          screen, so all three tabs showed the same thing and switching looked
          broken. "Ready for final delivery" stays — it has no tab. */}
      <View style={styles.banner}>
        <TaskBanners hideQueues={['dp_collect', 'dp_send', 'dp_pickup', 'dp_handback']} />
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
                        <StatusPill label="Ready for delivery" color={colors.success} />
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

  // Every leg but the last one is a physical custody change, and every physical
  // custody change in this app leaves a photo.
  const needsPhoto = row.current_status !== 'returned_to_delivery';
  // Only a piece handed over before 0084 arrives with no partner set.
  const needsPartnerPick = row.current_status === 'handed_over' && !row.partner_id;

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
    queryClient.invalidateQueries({ queryKey: ['pendingCollections'] });
  }

  const act = useMutation({
    mutationFn: async () => {
      // Photo legs upload first: the RPC rejects an empty url, so a failed
      // upload must surface as an upload error, not as a confusing DB refusal.
      if (needsPhoto) {
        const url = await uploadOrderPhoto(profile?.factory_id ?? '', row.order_id, photo[0].uri);
        if (row.current_status === 'awaiting_dp_collection') return collectFromFloor(row.repeat_id, url);
        if (row.current_status === 'handed_over') return handoverToPartner(row.repeat_id, url, partnerId);
        return collectFromPartner(row.repeat_id, url);
      }
      return handBackToFloor(row.repeat_id);
    },
    onSuccess: done,
    onError: (e) => setError(describeDbError(e, 'Delivery')),
  });

  const actionLabel =
    row.current_status === 'awaiting_dp_collection'
      ? 'Collect from Floor Manager'
      : row.current_status === 'handed_over'
        ? `Handover to ${row.partner_name ?? 'finishing partner'}`
        : row.current_status === 'handed_off'
          ? `Collect from ${row.partner_name ?? 'partner'}`
          : 'Return to Floor Manager';

  const photoLabel =
    row.current_status === 'awaiting_dp_collection'
      ? 'Photo of the piece as collected from the Floor Manager'
      : row.current_status === 'handed_over'
        ? `Photo of the piece as handed to ${row.partner_name ?? 'the partner'}`
        : `Photo of the piece as collected back from ${row.partner_name ?? 'the partner'}`;

  const canAct = needsPhoto
    ? photo.length > 0 && (!needsPartnerPick || !!partnerId)
    : true;

  return (
    <View style={[styles.card, row.sla_breached && styles.cardBreached]}>
      <Pressable onPress={onToggle} accessibilityRole="button" style={styles.cardHead}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.code}>{row.repeat_code}</Text>
          <Text style={styles.meta}>
            {row.order_code} · {row.vendor_name}
          </Text>
          <Text style={styles.meta}>
            Stage {row.stage_sequence ?? '—'} of {row.total_stages} · {stageLabel(row.stage_type)}
            {row.destination_stage ? ` → ${stageLabel(row.destination_stage)}` : ''}
          </Text>
          {row.partner_name ? (
            <Text style={styles.meta}>Partner: {row.partner_name}</Text>
          ) : null}
          <View style={styles.pills}>
            <RepeatStatusPill status={row.current_status} perspective="delivery" />
            {row.sla_breached ? <StatusPill label="SLA breached" color={colors.alert} /> : null}
            {/* The partner has said their work is done. Advisory, not a gate —
                collection still works without it (see 0062). */}
            {row.partner_ready_at ? (
              <StatusPill label="Partner finished — ready" color={colors.success} />
            ) : null}
          </View>
        </View>
        <View style={styles.chev}>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.slate}
          />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          {needsPhoto ? (
            <PhotoPicker
              label={photoLabel}
              hint="Required — this is the proof of physical custody."
              photos={photo}
              onChange={setPhoto}
              multiple={false}
              retakeLabel="Retake"
            />
          ) : null}

          {needsPartnerPick ? (
            <>
              <Text style={styles.note}>
                This piece was handed over before the Floor Manager began naming the partner, so
                there is no destination on it. Pick one to send it out.
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

          {row.current_status === 'returned_to_delivery' ? (
            <Text style={styles.note}>
              Returning prompts the Floor Manager to confirm they have the piece. It then goes
              through Stage QA for the {stageLabel(row.stage_type).toLowerCase()} work before it
              moves on.
            </Text>
          ) : null}

          {row.current_status === 'handed_off' && row.sla_hours ? (
            <Text style={styles.note}>
              SLA is {row.sla_hours}h from handover.
              {row.sla_breached ? ' This one is already past it.' : ''}
              {row.partner_ready_at
                ? ` ${row.partner_name ?? 'The partner'} marked it finished on ${new Date(
                    row.partner_ready_at
                  ).toLocaleDateString()}.`
                : ''}
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
    borderColor: colors.success,
  },
});

export default DeliveryOrdersScreen;
