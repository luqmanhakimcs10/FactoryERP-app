/**
 * Store Manager home — exactly four tabs: PO, Inventory, Audit, Requests.
 *
 * This replaces Stock Home, which had grown a PO card, a counter grid, two
 * action rows and a thread list all on one screen. Everything that was reachable
 * from it is still reachable; it now sits under whichever of the four tabs it
 * belongs to instead of competing for the same page.
 *
 * The tabs are sections of ONE screen rather than four navigator entries because
 * the brief says the main screen shows the four and nothing else — pushing a
 * route per tab would put a back arrow between them and make the set feel like
 * four places rather than one.
 *
 * Nothing here is a new working screen. Issuing material, confirming a GRN and
 * reading a stock ledger all open the screens that already do those jobs.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { StatusPill } from '../../components/ui/StatusPill';
import { EmptyState, Loading } from '../../components/ui/States';
import { AppButton } from '../../components/ui/AppButton';
import { matchesSearch } from '../../utils/search';
import { describeDbError } from '../../utils/errors';
import {
  listStorePos,
  listInventory,
  getAuditTodayState,
  getAuditHistory,
  getMaterialRequestHistory,
  ITEM_TYPE_LABEL,
  type ItemType,
  type InventoryItem,
  type SmPoRow,
  type AuditHistoryRow,
  type MaterialRequestRow,
} from '../../api/endpoints/storeManager';
import { getMaterialIssueQueue } from '../../api/endpoints/inventory';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

type TabKey = 'po' | 'inventory' | 'audit' | 'requests';

const TYPE_ICON: Record<ItemType, keyof typeof Ionicons.glyphMap> = {
  thread: 'git-commit-outline',
  tilla: 'sparkles-outline',
  sequin: 'ellipse-outline',
  bobbin: 'reload-outline',
};

/** Human wording for a PO's lifecycle state — the tab shows these, not the enum. */
const PO_STATUS_LABEL: Record<string, string> = {
  auto_generated: 'Raised automatically',
  draft: 'To raise',
  executed: 'Placed with supplier',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  paid: 'Paid',
  handed_over: 'On its way to you',
  received: 'Received',
  cancelled: 'Cancelled',
};

const REQUEST_STATUS_COLOR: Record<string, string> = {
  pending: colors.warning,
  issued: colors.primary,
  completed: colors.success,
  cancelled: colors.slate,
};

export function StoreManagerHomeScreen() {
  const navigation = useNavigation<any>();
  const [tab, setTab] = useState<TabKey>('po');
  const [search, setSearch] = useState('');

  const pos = useQuery({ queryKey: ['smPos'], queryFn: listStorePos });
  const inventory = useQuery({ queryKey: ['inventoryItems'], queryFn: () => listInventory() });
  const auditToday = useQuery({ queryKey: ['auditToday'], queryFn: getAuditTodayState });
  const audits = useQuery({ queryKey: ['auditHistory'], queryFn: () => getAuditHistory() });
  const requests = useQuery({ queryKey: ['materialRequests'], queryFn: getMaterialRequestHistory });
  const issueQueue = useQuery({ queryKey: ['issueQueue'], queryFn: getMaterialIssueQueue });

  const openRequests = (requests.data ?? []).filter((r) => r.status === 'pending').length;
  const openPos = (pos.data ?? []).filter(
    (p) => !['received', 'cancelled'].includes(p.status)
  ).length;

  const tabs = useMemo(
    () => [
      { key: 'po' as const, label: openPos ? `PO (${openPos})` : 'PO' },
      { key: 'inventory' as const, label: 'Inventory' },
      { key: 'audit' as const, label: auditToday.data?.done ? 'Audit' : 'Audit ●' },
      {
        key: 'requests' as const,
        label: openRequests ? `Requests (${openRequests})` : 'Requests',
      },
    ],
    [openPos, openRequests, auditToday.data?.done]
  );

  // ---- per-tab data, filtered by the one search box -----------------------
  const poRows = (pos.data ?? []).filter((p) =>
    matchesSearch(search, p.po_code, p.supplier_name, p.order_code, p.assigned_to)
  );
  const invRows = (inventory.data ?? []).filter((i) =>
    matchesSearch(search, i.color_code, i.color_name, ITEM_TYPE_LABEL[i.item_type])
  );
  const auditRows = (audits.data ?? []).filter((a) => matchesSearch(search, a.audit_code));
  const requestRows = (requests.data ?? []).filter((r) =>
    matchesSearch(search, r.request_code, r.order_code, r.vendor_name)
  );

  const active = { po: pos, inventory, audit: audits, requests }[tab];

  const searchPlaceholder = {
    po: 'Search PO, supplier or order',
    inventory: 'Search colour or type',
    audit: 'Search audit code',
    requests: 'Search request or order',
  }[tab];

  const data: any[] =
    tab === 'po' ? poRows : tab === 'inventory' ? invRows : tab === 'audit' ? auditRows : requestRows;

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder={searchPlaceholder}
        navigation={navigation}
      />

      <FlatList
        data={data}
        keyExtractor={(item) => item.id}
        // react-native-web's windowing never advanced past the first batch on
        // these lists, so long inventories silently stopped at ten rows.
        initialNumToRender={30}
        windowSize={21}
        removeClippedSubviews={false}
        refreshControl={
          <RefreshControl
            refreshing={!!active.isRefetching}
            onRefresh={() => active.refetch()}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.banners}>
              <TaskBanners />
            </View>

            <View style={styles.tabs}>
              <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} />
            </View>

            {tab === 'po' ? (
              <View style={styles.headerBlock}>
                <AppButton
                  title="New purchase order"
                  icon="add-circle-outline"
                  onPress={() => navigation.navigate('StoreNewPo')}
                />
              </View>
            ) : null}

            {tab === 'inventory' ? (
              <View style={styles.headerBlock}>
                <AppButton
                  title="Add stock"
                  icon="add-circle-outline"
                  onPress={() => navigation.navigate('AddInventory')}
                />
              </View>
            ) : null}

            {tab === 'audit' ? (
              <View style={styles.headerBlock}>
                {/* The brief's "mandatory" is a visible nudge, not a lock on the
                    other three tabs — see 0072's header for why. */}
                {auditToday.data?.done ? (
                  <ActionBanner
                    tone="neutral"
                    title="Today's audit is done"
                    subtitle={`${auditToday.data.item_count ?? 0} items counted — ${
                      auditToday.data.audit_code ?? ''
                    }`}
                  />
                ) : (
                  <ActionBanner
                    title="Today's audit has not been done"
                    subtitle="Count every item once a day — tap to start"
                    onPress={() => navigation.navigate('DailyAudit')}
                  />
                )}
                <Text style={styles.sectionTitle}>Past audits</Text>
              </View>
            ) : null}

            {tab === 'requests' && (issueQueue.data?.length ?? 0) > 0 ? (
              <View style={styles.headerBlock}>
                <ActionBanner
                  title={`${issueQueue.data!.length} request${
                    issueQueue.data!.length === 1 ? '' : 's'
                  } to issue`}
                  subtitle="The floor cannot start production until these go out"
                  onPress={() => navigation.navigate('MaterialIssueQueue')}
                />
              </View>
            ) : null}

            {active.isLoading ? <Loading /> : null}
            {active.isError ? (
              <Text style={styles.error}>{describeDbError(active.error, 'Store')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !active.isLoading ? (
            <View style={styles.empty}>
              <EmptyState
                icon="file-tray-outline"
                title={search ? 'Nothing matches' : EMPTY_TITLE[tab]}
                message={search ? 'Try a different search.' : EMPTY_BODY[tab]}
              />
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          // `data` is the union of the four row shapes; the active tab is what
          // decides which one this is, so each branch narrows it explicitly.
          if (tab === 'po') return <PoRow row={item as SmPoRow} navigation={navigation} />;
          if (tab === 'inventory')
            return <InventoryRow row={item as InventoryItem} navigation={navigation} />;
          if (tab === 'audit')
            return <AuditRow row={item as AuditHistoryRow} navigation={navigation} />;
          return <RequestRow row={item as MaterialRequestRow} navigation={navigation} />;
        }}
      />
    </Screen>
  );
}

const EMPTY_TITLE: Record<TabKey, string> = {
  po: 'No purchase orders',
  inventory: 'No stock recorded',
  audit: 'No audits yet',
  requests: 'No material requests',
};

const EMPTY_BODY: Record<TabKey, string> = {
  po: 'One is raised automatically when an order is short of stock, or you can create one.',
  inventory: 'Add thread, tilla, sequin or bobbin stock to get started.',
  audit: 'Do today’s audit and it will appear here.',
  requests: 'Requests appear here as the floor asks for material.',
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function PoRow({ row, navigation }: { row: SmPoRow; navigation: any }) {
  return (
    <Pressable
      onPress={() => navigation.navigate('PoDetail', { poId: row.id })}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTop}>
          <Text style={styles.code}>{row.po_code}</Text>
          {/* The brief asks for origin to be visible: the two kinds of PO behave
              differently and the store manager needs to know which they have. */}
          <StatusPill
            label={row.origin === 'auto_shortfall' ? 'Automatic' : 'Manual'}
            color={row.origin === 'auto_shortfall' ? colors.primary : colors.accent}
          />
        </View>
        <Text style={styles.sub}>
          {row.supplier_name ?? 'No supplier yet'}
          {row.order_code ? ` · ${row.order_code}` : ''}
          {` · ${row.line_count} line${row.line_count === 1 ? '' : 's'}`}
        </Text>
        <Text style={styles.hint}>
          {PO_STATUS_LABEL[row.status] ?? row.status}
          {row.assigned_to ? ` · ${row.assigned_to}` : ''}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.slate} />
    </Pressable>
  );
}

function InventoryRow({ row, navigation }: { row: InventoryItem; navigation: any }) {
  const low = row.reorder_threshold != null && Number(row.quantity) < Number(row.reorder_threshold);
  return (
    <Pressable
      onPress={() => navigation.navigate('StockLedger', { colorCode: row.color_code })}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
    >
      <Ionicons name={TYPE_ICON[row.item_type]} size={20} color={colors.primary} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTop}>
          <Text style={styles.code}>{row.color_code}</Text>
          {/* How this stock got here — the brief's PO vs Manual badge. */}
          <StatusPill
            label={row.source === 'po' ? 'PO' : 'Manual'}
            color={row.source === 'po' ? colors.primary : colors.slate}
          />
        </View>
        <Text style={styles.sub}>
          {ITEM_TYPE_LABEL[row.item_type]}
          {row.size_mm ? ` · ${row.size_mm} mm` : ''}
          {row.sequin_type ? ` · ${row.sequin_type}` : ''}
          {row.color_name ? ` · ${row.color_name}` : ''}
        </Text>
      </View>
      <Text style={[styles.qty, (low || Number(row.quantity) <= 0) && { color: colors.alert }]}>
        {Number(row.quantity).toLocaleString()} {row.unit}
      </Text>
    </Pressable>
  );
}

function AuditRow({ row, navigation }: { row: AuditHistoryRow; navigation: any }) {
  const date = new Date(row.audit_date + 'T00:00:00');
  return (
    <Pressable
      onPress={() => navigation.navigate('AuditDetail', { auditId: row.id, code: row.audit_code })}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.code}>
          Audit of {date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
        </Text>
        <Text style={styles.sub}>
          {row.item_count} item{row.item_count === 1 ? '' : 's'} counted
          {row.corrected > 0 ? ` · ${row.corrected} corrected` : ' · all correct'}
          {row.conducted_by ? ` · ${row.conducted_by}` : ''}
        </Text>
      </View>
      {row.audit_type === 'weekly' ? (
        <StatusPill label="Weekly" color={colors.slate} />
      ) : null}
      <Ionicons name="chevron-forward" size={18} color={colors.slate} />
    </Pressable>
  );
}

function RequestRow({ row, navigation }: { row: MaterialRequestRow; navigation: any }) {
  // A job-card request the store still owes opens the screen that issues it.
  // Everything else is history: the store manager has no order-detail route
  // registered, so making those rows pressable would navigate to nothing.
  const actionable = row.status === 'pending' && row.origin === 'job_card' && !!row.job_card_id;
  return (
    <Pressable
      onPress={
        actionable
          ? () =>
              navigation.navigate('IssueDetail', {
                jobCardId: row.job_card_id,
                orderCode: row.order_code,
              })
          : undefined
      }
      disabled={!actionable}
      style={({ pressed }) => [styles.row, pressed && actionable && styles.rowPressed]}
      accessibilityRole={actionable ? 'button' : undefined}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTop}>
          <Text style={styles.code}>{row.order_code}</Text>
          <StatusPill
            label={row.status === 'pending' ? 'Waiting' : row.status === 'issued' ? 'Issued' : 'Done'}
            color={REQUEST_STATUS_COLOR[row.status] ?? colors.slate}
          />
        </View>
        <Text style={styles.sub}>
          {row.origin === 'auto_stock_ready' ? 'Material ready in store' : 'Asked for by the floor'}
          {row.vendor_name ? ` · ${row.vendor_name}` : ''}
        </Text>
        <Text style={styles.hint}>
          {row.request_code} · {new Date(row.requested_at).toLocaleDateString()}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.slate} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banners: { marginHorizontal: spacing.lg, marginTop: spacing.lg },
  tabs: { paddingTop: spacing.lg, paddingBottom: spacing.sm },
  headerBlock: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.indigoDeep,
    fontWeight: fontWeight.medium,
  },
  sub: { fontSize: fontSize.secondary, color: colors.slate },
  hint: { fontSize: fontSize.caption, color: colors.slate },
  qty: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep },
  empty: { padding: spacing.xl },
  error: { paddingHorizontal: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
});
