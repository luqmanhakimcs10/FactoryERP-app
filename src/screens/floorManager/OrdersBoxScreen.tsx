/**
 * Orders box — Floor Manager.
 *
 * Four tabs: Overview (count + active orders), Awaiting job card (the queue
 * that used to be the floor manager's whole home screen — tapping an order
 * opens the existing Job Card Builder, unchanged), Accept inventory (Phase 4's
 * material-issue flow, floor manager's side — see migration 0035), and Final
 * QA (the existing FinalQaQueue screen, just relocated under this box since it
 * didn't fit any of the other four).
 */
import React, { useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
import { AppButton } from '../../components/ui/AppButton';
import { ListRow } from '../../components/lists/ListRow';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { listOrders, countOrders, startProduction } from '../../api/endpoints/orders';
import {
  listPendingMaterialAcceptance,
  listMaterialIssueLines,
  acceptInventory,
} from '../../api/endpoints/inventory';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { useNextStep, NEXT_STEP } from '../../components/ui/NextStepToast';
import { getHandoverQueue } from '../../api/endpoints/storeManager';
import { describeDbError } from '../../utils/errors';
import { ACTIVE_ORDER_STATUSES } from '../../models/orderTypes';
import type { OrderListRow, OrderStatus } from '../../models/orderTypes';
import type { PendingMaterialIssueRow } from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  tint,
} from '../../constants/theme';

const ACTIVE_STATUSES = ACTIVE_ORDER_STATUSES;
const JOB_CARD_STATUSES: OrderStatus[] = ['awaiting_job_card', 'job_card_shared'];

type TabKey = 'overview' | 'job_card' | 'accept_inventory' | 'final_qa' | 'handover';

export function OrdersBoxScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const queryClient = useQueryClient();
  const showNextStep = useNextStep();
  // Accepting material is an INLINE action on the Accept-inventory tab, not a
  // per-item screen, so the dashboard banner deep-links to the tab. Navigation
  // only — the tab's own content and behaviour are untouched.
  const [activeTab, setActiveTab] = useState<TabKey>(
    (route.params?.tab as TabKey) ?? 'overview'
  );
  const [startError, setStartError] = useState<string | null>(null);

  const { data: totalCount } = useQuery({ queryKey: ['orderCount'], queryFn: countOrders });
  const { data: active, isLoading: activeLoading } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => listOrders(ACTIVE_STATUSES),
  });
  const { data: jobCardQueue, isLoading: jobCardLoading } = useQuery({
    queryKey: ['orders', 'fmJobCard'],
    queryFn: () => listOrders(JOB_CARD_STATUSES),
  });
  // Same query the Accept inventory tab runs. React Query dedupes on the shared
  // key, so reading it here for the tab's count costs nothing extra — this is
  // the same live-count pattern "Awaiting job card" already uses.
  const { data: pendingMaterial } = useQuery({
    queryKey: ['pendingMaterialAcceptance'],
    queryFn: listPendingMaterialAcceptance,
  });

  // Finished orders whose leftover material has not been handed back yet.
  const { data: handoverQueue } = useQuery({
    queryKey: ['handoverQueue'],
    queryFn: getHandoverQueue,
  });

  const startProductionMutation = useMutation({
    mutationFn: (orderId: string) => startProduction(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      showNextStep(NEXT_STEP.productionStarted);
    },
    onError: (e) => setStartError(describeDbError(e, 'Start production')),
  });

  return (
    <Screen padded={false}>
      <SegmentedTabs
        value={activeTab}
        onChange={setActiveTab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          {
            key: 'job_card',
            label: `Awaiting job card${jobCardQueue?.length ? ` (${jobCardQueue.length})` : ''}`,
          },
          {
            key: 'accept_inventory',
            label: `Accept inventory${pendingMaterial?.length ? ` (${pendingMaterial.length})` : ''}`,
          },
          { key: 'final_qa', label: 'Final QA' },
          {
            key: 'handover',
            label: `Handover${handoverQueue?.length ? ` (${handoverQueue.length})` : ''}`,
          },
        ]}
      />

      {activeTab === 'overview' ? (
        <FlatList
          data={active ?? []}
          keyExtractor={(o) => o.id}
          // Virtualisation was capping this list at its initial 10 rows: on
          // react-native-web the windowing pass never advanced, so scrolling hit
          // the bottom of the rendered content and stopped — orders 11+ (which
          // included every order awaiting machine selection) were unreachable.
          // These lists are tens of rows, not thousands, so rendering them all
          // is cheaper than being subtly wrong.
          initialNumToRender={ACTIVE_STATUSES.length && active ? active.length : 20}
          windowSize={21}
          removeClippedSubviews={false}
          ListHeaderComponent={
            <View>
              <View style={styles.counter}>
                <StatGrid>
                  <StatCard
                    value={totalCount == null ? '—' : String(totalCount)}
                    label="Total orders"
                    icon="document-text-outline"
                  />
                </StatGrid>
              </View>
              {/* The "Collect [stage]" prompt stood here — pieces the delivery
                  person had handed back, waiting on a confirmation press. 0092
                  removed the wait: a returning piece goes from the delivery
                  person straight to the Inspector, so there is nothing for the
                  Floor Manager to acknowledge on its way past. */}
              <Text style={styles.sectionTitle}>Active orders ({active?.length ?? 0})</Text>
              {activeLoading ? <ActivityIndicator color={colors.indigo} /> : null}
              {startError ? <Text style={styles.error}>{startError}</Text> : null}
            </View>
          }
          ListEmptyComponent={
            !activeLoading ? <Text style={styles.emptyBody}>No orders currently in progress.</Text> : null
          }
          renderItem={({ item }) => {
            const atMachineStep = item.status === 'machine_selection_pending';
            const inProduction = item.status === 'in_production' || item.status === 'in_finishing';
            return (
              <OrderRow
                order={item}
                // Fix 3: at the machine step BOTH controls are on the row at
                // once. Previously "Start production" only appeared after the
                // assign modal had been dismissed, so the two halves of one
                // decision were never visible together.
                machineStep={atMachineStep}
                assignedMachine={!!item.assigned_machine_id}
                onAssign={() => navigation.navigate('AssignMachine', { orderId: item.id })}
                onStart={() => {
                  setStartError(null);
                  startProductionMutation.mutate(item.id);
                }}
                starting={startProductionMutation.isPending && startProductionMutation.variables === item.id}
                action={inProduction ? 'Order details' : undefined}
                /*
                 * ALWAYS the three-tab order screen. An order in production used
                 * to open Stage Tracking instead, which meant the one order the
                 * granular status board is most useful for was the one order you
                 * could not reach it from. Stage Tracking is still one tap away —
                 * it is the button on the Progress tab, where the piece-by-piece
                 * actions belong.
                 */
                onPress={() => {
                  if (!atMachineStep) {
                    navigation.navigate('FmOrderDetail', { orderId: item.id });
                  }
                }}
              />
            );
          }}
          /* The "Master data · Vendors" shortcut was here. Master data is the
             company admin's, not the floor's — a link to the client list on the
             screen where production is run is a door to a section this role has
             no reason to open mid-shift. */
        />
      ) : null}

      {activeTab === 'job_card' ? (
        <FlatList
          data={jobCardQueue ?? []}
          keyExtractor={(o) => o.id}
          ListHeaderComponent={
            <View>
              <Text style={styles.sectionTitle}>Awaiting job card</Text>
              {jobCardLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            </View>
          }
          ListEmptyComponent={
            !jobCardLoading ? (
              <Text style={styles.emptyBody}>
                Orders appear here once QA marks "Continue to job card."
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <JobCardQueueRow
              order={item}
              onCreate={() => navigation.navigate('JobCardBuilder', { orderId: item.id })}
              onOpen={() => navigation.navigate('JobCard', { orderId: item.id })}
            />
          )}
        />
      ) : null}

      {activeTab === 'accept_inventory' ? <AcceptInventoryTab /> : null}

      {activeTab === 'final_qa' ? (
        <View style={styles.content}>
          <Text style={styles.body}>
            Repeats that have cleared every finishing stage and are ready for a final quality
            check before invoicing.
          </Text>
          <AppButton title="Open Final QA queue" onPress={() => navigation.navigate('FinalQaQueue')} />
        </View>
      ) : null}

      {/* Handing leftover material back to the store once an order is done.
          Lives here rather than on a dashboard card because it is a per-order
          action on a finished order, which is exactly what this box holds. */}
      {activeTab === 'handover' ? (
        <FlatList
          data={handoverQueue ?? []}
          keyExtractor={(o) => o.order_id}
          initialNumToRender={20}
          windowSize={21}
          removeClippedSubviews={false}
          ListHeaderComponent={
            <Text style={styles.body}>
              Finished orders that still have material signed out to the floor. Log what is left
              over and it goes back into store stock.
            </Text>
          }
          ListEmptyComponent={
            <Text style={styles.emptyBody}>Nothing waiting to be handed back.</Text>
          }
          renderItem={({ item }) => (
            <View style={styles.handoverRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.handoverCode}>{item.order_code}</Text>
                <Text style={styles.emptyBody}>
                  {item.vendor_name ?? 'No client'} · {item.line_count} item
                  {item.line_count === 1 ? '' : 's'} issued
                </Text>
              </View>
              <AppButton
                title="Hand over"
                size="sm"
                onPress={() =>
                  navigation.navigate('HandoverToStore', {
                    orderId: item.order_id,
                    orderCode: item.order_code,
                  })
                }
              />
            </View>
          )}
        />
      ) : null}
    </Screen>
  );
}

function AcceptInventoryTab() {
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['pendingMaterialAcceptance'],
    queryFn: listPendingMaterialAcceptance,
  });

  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(r) => r.material_issue_id}
      ListHeaderComponent={
        <View>
          <Text style={styles.sectionTitle}>Material ready for pickup ({data?.length ?? 0})</Text>
          {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
        </View>
      }
      ListEmptyComponent={
        !isLoading ? <Text style={styles.emptyBody}>Nothing waiting on pickup.</Text> : null
      }
      renderItem={({ item }) => (
        <AcceptInventoryRow
          row={item}
          open={openId === item.material_issue_id}
          onToggle={() =>
            setOpenId(openId === item.material_issue_id ? null : item.material_issue_id)
          }
          onDone={() => setOpenId(null)}
        />
      )}
    />
  );
}

/**
 * One material issue, received line by line. (0084, Fix 1)
 *
 * The old row offered a single "Accept inventory" button over a summary that
 * read "3 colours, 412 m". Nobody can check a physical delivery against that,
 * so in practice nobody did — the button meant "the material arrived, probably".
 *
 * Now every line on the issue is listed with its quantity and a checkbox, and
 * the Floor Manager ticks each one as it is counted in. ALL lines must be
 * ticked: `fm_accept_inventory` refuses a partial set, so the disabled button
 * below is a courtesy, not the rule. Partial receipt is deliberately not
 * supported — a half-accepted issue needs its own status and its own shortfall
 * record, which is a different feature rather than a looser version of this one.
 */
function AcceptInventoryRow({
  row,
  open,
  onToggle,
  onDone,
}: {
  row: PendingMaterialIssueRow;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const showNextStep = useNextStep();
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [photo, setPhoto] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: lines, isLoading: linesLoading } = useQuery({
    queryKey: ['materialIssueLines', row.material_issue_id],
    queryFn: () => listMaterialIssueLines(row.material_issue_id),
    enabled: open,
  });

  const items = lines ?? [];
  const tickedIds = items.filter((l) => checked[l.item_id]).map((l) => l.item_id);
  const allTicked = items.length > 0 && tickedIds.length === items.length;

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!photo[0] || !profile?.factory_id) {
        throw new Error('Take a photo of the received materials first.');
      }
      const path = await uploadOrderPhoto(
        profile.factory_id, row.order_id, photo[0].uri, 'material-accepted'
      );
      return acceptInventory(row.material_issue_id, path, tickedIds);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingMaterialAcceptance'] });
      queryClient.invalidateQueries({ queryKey: ['floorManagerCardCounts'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      // Accepting inventory is precisely what makes an order assignable, so the
      // Assign Machine picker must be refetched too. Without this the order only
      // appears after the 30s staleTime lapses or the app is reloaded — the
      // second half of the ALP-00098 bug.
      queryClient.invalidateQueries({ queryKey: ['assignableOrders'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
      setChecked({});
      setPhoto([]);
      onDone();
      showNextStep(NEXT_STEP.inventoryAccepted);
    },
    onError: (e) => setError(describeDbError(e, 'Accept inventory')),
  });

  return (
    <View style={styles.issueRow}>
      <View style={{ flex: 1 }}>
        <View style={styles.issueRowMain}>
          <Text style={styles.code}>{row.order_code}</Text>
          <Text style={styles.vendor} numberOfLines={1}>
            {row.vendor_name}
          </Text>
          <Text style={styles.meta}>
            Requested by {row.issued_by_name} ·{' '}
            <Text style={styles.mono}>{Number(row.total_meters).toLocaleString()}</Text> m ·{' '}
            {row.colors} item{row.colors === 1 ? '' : 's'}
          </Text>
        </View>

        {open ? (
          <View style={styles.captureBox}>
            <Text style={styles.checklistHead}>
              Tick each item as you physically receive it
              {items.length ? ` — ${tickedIds.length} of ${items.length}` : ''}
            </Text>

            {linesLoading ? <ActivityIndicator color={colors.indigo} /> : null}

            {items.map((line) => {
              const on = !!checked[line.item_id];
              return (
                <Pressable
                  key={line.item_id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${line.color_code}, ${line.issued_meters} ${line.unit}`}
                  onPress={() => setChecked((c) => ({ ...c, [line.item_id]: !on }))}
                  style={({ pressed }) => [
                    styles.lineRow,
                    on && styles.lineRowOn,
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <View style={[styles.checkbox, on && styles.checkboxOn]}>
                    {on ? <Ionicons name="checkmark" size={15} color={colors.white} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.lineName}>{line.color_code}</Text>
                    <Text style={styles.lineMeta}>{line.item_type}</Text>
                  </View>
                  <Text style={styles.lineQty}>
                    {Number(line.issued_meters).toLocaleString()} {line.unit}
                  </Text>
                </Pressable>
              );
            })}

            {!linesLoading && items.length === 0 ? (
              <Text style={styles.emptyBody}>This issue has no lines to receive.</Text>
            ) : null}

            <PhotoPicker
              label="Photo of received materials"
              photos={photo}
              onChange={setPhoto}
              multiple={false}
            />

            {!allTicked && items.length > 0 ? (
              <Text style={styles.gateHint}>
                Every item has to be ticked before the receipt can be confirmed.
              </Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.captureActions}>
              <AppButton
                title="Cancel"
                variant="secondary"
                onPress={() => {
                  setChecked({});
                  setPhoto([]);
                  setError(null);
                  onToggle();
                }}
                disabled={acceptMutation.isPending}
                style={{ flex: 1 }}
              />
              <AppButton
                title={`Confirm receipt${items.length ? ` (${tickedIds.length}/${items.length})` : ''}`}
                variant="brass"
                onPress={() => {
                  setError(null);
                  acceptMutation.mutate();
                }}
                loading={acceptMutation.isPending}
                disabled={!allTicked || !photo[0]}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ) : (
          <AppButton
            title="Accept inventory"
            variant="brass"
            onPress={onToggle}
            style={styles.acceptBtn}
          />
        )}
      </View>
    </View>
  );
}

/** "Awaiting job card" row — a standalone action button, not a whole-row tap,
 * since the builder is a multi-step flow you shouldn't fall into by accident. */
function JobCardQueueRow({
  order,
  onCreate,
  onOpen,
}: {
  order: OrderListRow;
  onCreate: () => void;
  onOpen: () => void;
}) {
  const notYetBuilt = order.status === 'awaiting_job_card';
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Text style={styles.code}>{order.order_code}</Text>
        <OrderStatusPill status={order.status} />
      </View>
      <Text style={styles.vendor} numberOfLines={1}>
        {order.vendor_name}
      </Text>
      <AppButton
        title={notYetBuilt ? 'Create Job Card' : 'Open job card'}
        variant={notYetBuilt ? 'primary' : 'secondary'}
        onPress={notYetBuilt ? onCreate : onOpen}
        style={styles.queueRowBtn}
      />
    </View>
  );
}

function OrderRow({
  order,
  action,
  busy,
  onPress,
  machineStep,
  assignedMachine,
  onAssign,
  onStart,
  starting,
}: {
  order: OrderListRow;
  action?: string;
  busy?: boolean;
  onPress: () => void;
  /** Order is at machine_selection_pending — show both controls side by side. */
  machineStep?: boolean;
  assignedMachine?: boolean;
  onAssign?: () => void;
  onStart?: () => void;
  starting?: boolean;
}) {
  const body = (
    <>
      <View style={styles.rowTop}>
        <Text style={styles.code}>{order.order_code}</Text>
        <OrderStatusPill status={order.status} />
      </View>
      <Text style={styles.vendor} numberOfLines={1}>
        {order.vendor_name}
      </Text>
    </>
  );

  // Both buttons, always both visible. "Start Production" is disabled rather
  // than hidden before a machine exists: hiding it is what made the second step
  // feel like it didn't exist until you'd guessed at the first.
  if (machineStep) {
    return (
      <View style={styles.row}>
        {body}
        <View style={styles.machineActions}>
          <AppButton
            title={assignedMachine ? 'Machine assigned ✓' : 'Assign Machine'}
            variant={assignedMachine ? 'secondary' : 'primary'}
            size="sm"
            onPress={onAssign!}
            style={{ flex: 1 }}
          />
          <AppButton
            title="Start Production"
            variant="brass"
            size="sm"
            disabled={!assignedMachine}
            loading={starting}
            onPress={onStart!}
            style={{ flex: 1 }}
          />
        </View>
        {!assignedMachine ? (
          <Text style={styles.hint}>
            Assign a machine — worker, photo and start time are captured in the same step.
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {body}
      {busy ? (
        <ActivityIndicator color={colors.indigo} style={{ alignSelf: 'flex-start', marginTop: spacing.xs }} />
      ) : action ? (
        <Text style={styles.action}>{action} →</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  handoverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  handoverCode: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  content: { padding: spacing.xl, gap: spacing.lg },
  body: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  counter: { margin: spacing.lg, marginBottom: spacing.sm },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  emptyBody: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, fontSize: fontSize.secondary, color: colors.slate },
  error: { paddingHorizontal: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
  row: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    gap: 2,
  },
  machineActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  hint: { marginTop: spacing.sm, fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  rowPressed: { opacity: 0.75 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.monoSemibold, fontSize: fontSize.body, color: colors.ink, fontWeight: fontWeight.semibold },
  vendor: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono },
  action: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.accent, fontWeight: fontWeight.semibold },
  queueRowBtn: { marginTop: spacing.sm, alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: spacing.lg },
  issueRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  issueRowMain: { gap: 2, marginBottom: spacing.sm },
  acceptBtn: { minHeight: 40, paddingHorizontal: spacing.md, alignSelf: 'flex-start' },
  captureBox: { marginTop: spacing.sm, gap: spacing.sm },
  captureActions: { flexDirection: 'row', gap: spacing.md },
  // ---- Itemised receipt checklist (0084) ----
  checklistHead: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    // Comfortably past the 44pt touch minimum: this is tapped with gloves on,
    // standing next to a trolley, once per line.
    minHeight: 52,
  },
  lineRowOn: { borderColor: colors.success, backgroundColor: tint(colors.success, 0.08) },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.slate,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { borderColor: colors.success, backgroundColor: colors.success },
  lineName: { fontSize: fontSize.secondary, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  lineMeta: { fontSize: fontSize.caption, color: colors.slate, textTransform: 'capitalize' },
  lineQty: { fontFamily: fontFamily.mono, fontSize: fontSize.secondary, color: colors.indigoDeep },
  gateHint: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  footer: { marginTop: spacing.xl },
});

export default OrdersBoxScreen;
