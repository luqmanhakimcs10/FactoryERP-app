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
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
import { AppButton } from '../../components/ui/AppButton';
import { ListRow } from '../../components/lists/ListRow';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { CollectPrompt } from '../../components/ui/CollectPrompt';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { listOrders, countOrders, startProduction } from '../../api/endpoints/orders';
import { listPendingMaterialAcceptance, acceptInventory } from '../../api/endpoints/inventory';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { useNextStep, NEXT_STEP } from '../../components/ui/NextStepToast';
import { describeDbError } from '../../utils/errors';
import type { OrderListRow, OrderStatus } from '../../models/orderTypes';
import type { PendingMaterialIssueRow } from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

const ACTIVE_STATUSES: OrderStatus[] = [
  'awaiting_procurement',
  'awaiting_cloth_inspection',
  'awaiting_coding',
  'awaiting_job_card',
  'job_card_shared',
  'job_card_confirmed',
  'machine_selection_pending',
  'in_production',
  'in_finishing',
  'awaiting_final_qa',
  'ready_for_delivery',
];
const JOB_CARD_STATUSES: OrderStatus[] = ['awaiting_job_card', 'job_card_shared'];

type TabKey = 'overview' | 'job_card' | 'accept_inventory' | 'final_qa';

export function OrdersBoxScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const showNextStep = useNextStep();
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
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
              {/* Pieces handed back by the delivery person, across every order. */}
              <View style={styles.promptWrap}>
                <CollectPrompt />
              </View>
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
                action={inProduction ? 'Stage tracking' : undefined}
                onPress={() => {
                  if (inProduction) {
                    navigation.navigate('StageTracking', { orderId: item.id });
                  } else if (!atMachineStep) {
                    navigation.navigate('OrderDetail', { orderId: item.id });
                  }
                }}
              />
            );
          }}
          ListFooterComponent={
            <View style={styles.footer}>
              <Text style={styles.sectionTitle}>Master data</Text>
              <ListRow title="Vendors" onPress={() => navigation.navigate('MasterList', { entity: 'vendors' })} />
            </View>
          }
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
                Orders appear here once Initial QA marks "Continue to job card."
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
    </Screen>
  );
}

function AcceptInventoryTab() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const showNextStep = useNextStep();
  const [error, setError] = useState<string | null>(null);
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [photo, setPhoto] = useState<LocalPhoto[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['pendingMaterialAcceptance'],
    queryFn: listPendingMaterialAcceptance,
  });

  const acceptMutation = useMutation({
    mutationFn: async ({ row }: { row: PendingMaterialIssueRow }) => {
      if (!photo[0] || !profile?.factory_id) throw new Error('Take a photo of the received materials first.');
      const path = await uploadOrderPhoto(profile.factory_id, row.order_id, photo[0].uri, 'material-accepted');
      return acceptInventory(row.material_issue_id, path);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingMaterialAcceptance'] });
      queryClient.invalidateQueries({ queryKey: ['floorManagerCardCounts'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      // Accepting inventory is precisely what makes an order assignable, so the
      // Open Shift / Assign Machine picker must be refetched too. Without this
      // the order only appears after the 30s staleTime lapses or the app is
      // reloaded — the second half of the ALP-00098 bug.
      queryClient.invalidateQueries({ queryKey: ['assignableOrders'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
      setCapturingId(null);
      setPhoto([]);
      showNextStep(NEXT_STEP.inventoryAccepted);
    },
    onError: (e) => setError(describeDbError(e, 'Accept inventory')),
  });

  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(r) => r.material_issue_id}
      ListHeaderComponent={
        <View>
          <Text style={styles.sectionTitle}>Material ready for pickup ({data?.length ?? 0})</Text>
          {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      }
      ListEmptyComponent={
        !isLoading ? <Text style={styles.emptyBody}>Nothing waiting on pickup.</Text> : null
      }
      renderItem={({ item }) => (
        <AcceptInventoryRow
          row={item}
          capturing={capturingId === item.material_issue_id}
          photo={capturingId === item.material_issue_id ? photo : []}
          busy={acceptMutation.isPending && capturingId === item.material_issue_id}
          onStartCapture={() => {
            setError(null);
            setPhoto([]);
            setCapturingId(item.material_issue_id);
          }}
          onCancelCapture={() => {
            setCapturingId(null);
            setPhoto([]);
          }}
          onChangePhoto={setPhoto}
          onConfirm={() => {
            setError(null);
            acceptMutation.mutate({ row: item });
          }}
        />
      )}
    />
  );
}

function AcceptInventoryRow({
  row,
  capturing,
  photo,
  busy,
  onStartCapture,
  onCancelCapture,
  onChangePhoto,
  onConfirm,
}: {
  row: PendingMaterialIssueRow;
  capturing: boolean;
  photo: LocalPhoto[];
  busy: boolean;
  onStartCapture: () => void;
  onCancelCapture: () => void;
  onChangePhoto: (photos: LocalPhoto[]) => void;
  onConfirm: () => void;
}) {
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
            {row.colors} colour{row.colors === 1 ? '' : 's'}
          </Text>
        </View>

        {capturing ? (
          <View style={styles.captureBox}>
            <PhotoPicker
              label="Photo of received materials"
              photos={photo}
              onChange={onChangePhoto}
              multiple={false}
            />
            <View style={styles.captureActions}>
              <AppButton
                title="Cancel"
                variant="secondary"
                onPress={onCancelCapture}
                disabled={busy}
                style={{ flex: 1 }}
              />
              <AppButton
                title="Confirm accept"
                variant="brass"
                onPress={onConfirm}
                loading={busy}
                disabled={!photo[0]}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ) : (
          <AppButton
            title="Accept inventory"
            variant="brass"
            onPress={onStartCapture}
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
  promptWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
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
  captureBox: { marginTop: spacing.sm },
  captureActions: { flexDirection: 'row', gap: spacing.md },
  footer: { marginTop: spacing.xl },
});

export default OrdersBoxScreen;
