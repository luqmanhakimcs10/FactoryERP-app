/**
 * Delivery Person — ONE tab: Orders. (Fix 1)
 *
 * This replaces the Handoff / Return / SLA three-tab split. All four legs of
 * this role's work are the same job seen at different moments, so they are one
 * list here, and each row offers exactly the action its status permits:
 *
 *   To Collect        -> Collect (photo)      [from the Floor Manager]
 *   Delivery waiting  -> pick handler, then Handover to finishing partner
 *   Out at Partner    -> Collect (photo)      [back from the partner]
 *   Collected         -> Hand back to Floor Manager
 *
 * The action is derived from `current_status` alone rather than from local
 * state, so a row that someone else advanced simply re-renders with its new
 * action on the next refetch instead of offering a button that will be refused.
 *
 * SLA-breached rows sort to the top and carry an alert pill — the old separate
 * "SLA Alerts" tab existed only because the queue could not show urgency
 * inline, which a single sorted list can.
 *
 * Order within the list (set by `dp_orders_queue`, 0062): breached first, then
 * pieces a finishing partner has marked finished, then NEWEST FIRST. New work
 * used to land at the bottom, which is the one place nobody looks.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable, RefreshControl } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { ActionBanner } from '../../components/ui/ActionBanner';
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
  sendToPartner,
  collectFromPartner,
  handBackToFloor,
  type DpOrderRow,
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

export function DeliveryOrdersScreen({ navigation }: any) {
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['dpOrders'],
    queryFn: listDeliveryOrders,
  });

  // The final handover to the client. It belongs in THIS list rather than a tab
  // of its own — the brief allows exactly one tab, and an order that has
  // cleared every stage is still this role's work, just the last leg of it.
  const { data: finalDeliveries } = useQuery({
    queryKey: ['dpFinalDelivery'],
    queryFn: listFinalDeliveryQueue,
  });

  const rows = (data ?? []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      r.repeat_code.toLowerCase().includes(q) ||
      (r.order_code ?? '').toLowerCase().includes(q) ||
      (r.vendor_name ?? '').toLowerCase().includes(q) ||
      (r.stage_type ?? '').toLowerCase().includes(q) ||
      (r.partner_name ?? '').toLowerCase().includes(q)
    );
  });

  const breached = rows.filter((r) => r.sla_breached).length;

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Repeat, order, vendor, stage…"
        navigation={navigation}
      />
      {/* One tab. Rendered as a header rather than a tab bar precisely because
          there is nothing to switch to — a lone tab that cannot be left is a
          control that lies about having options. */}
      <View style={styles.head}>
        <Text style={styles.title}>Orders</Text>
        <Text style={styles.sub}>
          {rows.length} item{rows.length === 1 ? '' : 's'} to move
          {breached > 0 ? ` · ${breached} past SLA` : ''}
        </Text>
        <View style={styles.stitch} />
      </View>

      {/* Only raised for work that is actually LATE. A banner that fired for
          every queued item would be noise on a screen that is nothing but a
          queue. */}
      {breached > 0 ? (
        <ActionBanner
          title={`${breached} piece${breached === 1 ? '' : 's'} past their SLA`}
          subtitle="These are overdue at a finishing partner — chase or collect"
          style={styles.banner}
        />
      ) : null}

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
            (finalDeliveries?.length ?? 0) === 0 ? (
              <EmptyState
                icon="cube-outline"
                title="Nothing to move right now"
                message="Pieces appear here the moment a Floor Manager hands a stage over, and stay until you've handed them back."
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
            (finalDeliveries?.length ?? 0) > 0 ? (
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

  const needsPhoto = row.current_status === 'awaiting_dp_collection' || row.current_status === 'handed_off';
  const needsPartner = row.current_status === 'handed_over';

  const { data: partners, isLoading: partnersLoading } = useQuery({
    queryKey: ['finishingPartnerOptions'],
    queryFn: () => listLinkedOptions('finishing_partners', 'name'),
    enabled: needsPartner && expanded,
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
        return row.current_status === 'awaiting_dp_collection'
          ? collectFromFloor(row.repeat_id, url)
          : collectFromPartner(row.repeat_id, url);
      }
      if (needsPartner) return sendToPartner(row.repeat_id, partnerId!);
      return handBackToFloor(row.repeat_id);
    },
    onSuccess: done,
    onError: (e) => setError(describeDbError(e, 'Delivery')),
  });

  const actionLabel =
    row.current_status === 'awaiting_dp_collection'
      ? 'Collect'
      : row.current_status === 'handed_over'
        ? 'Handover to finishing partner'
        : row.current_status === 'handed_off'
          ? 'Collect'
          : 'Hand back to Floor Manager';

  const canAct = needsPhoto ? photo.length > 0 : needsPartner ? !!partnerId : true;

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
            {row.partner_name ? ` · ${row.partner_name}` : ''}
          </Text>
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
              label={
                row.current_status === 'awaiting_dp_collection'
                  ? 'Photo of the piece as collected from the Floor Manager'
                  : `Photo of the piece as collected back from ${row.partner_name ?? 'the partner'}`
              }
              hint="Required — this is the proof of physical custody."
              photos={photo}
              onChange={setPhoto}
              multiple={false}
              retakeLabel="Retake"
            />
          ) : null}

          {needsPartner ? (
            <SelectField
              label={`${stageLabel(row.stage_type)} person select`}
              value={partnerId}
              onChange={setPartnerId}
              options={partners ?? []}
              loading={partnersLoading}
              required
              emptyHint="No finishing partners on file yet — add one under Master data."
            />
          ) : null}

          {row.current_status === 'returned_to_delivery' ? (
            <Text style={styles.note}>
              Handing back prompts the Floor Manager to confirm they have collected{' '}
              {stageLabel(row.stage_type).toLowerCase()}. The next stage starts as soon as they do.
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
  head: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  sub: { marginTop: 2, fontSize: fontSize.secondary, color: colors.slate },
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
