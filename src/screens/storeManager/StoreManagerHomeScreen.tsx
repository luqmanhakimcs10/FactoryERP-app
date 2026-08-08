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
import { View, Text, ScrollView, StyleSheet, Pressable, RefreshControl } from 'react-native';
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

      {/*
        A ScrollView with a flex-wrapped grid, NOT a FlatList with numColumns.
        Two reasons, in order of importance:

        1. It is the same mechanism `CardGrid` uses for every other dashboard's
           grid, and this screen is meant to match them. One way to lay out a
           grid in this app, not two.
        2. FlatList's numColumns is genuinely hostile here. It throws
           "Changing numColumns on the fly is not supported" if the value ever
           differs between renders, and it internally drops to one column to
           render ListEmptyComponent — so an empty tab trips the invariant and
           takes the whole screen down with it. That is exactly what happened:
           the dashboard went blank on the first tab with no rows.

        These lists are tens of items and were already rendering in full
        (removeClippedSubviews was off, initialNumToRender covered them), so no
        virtualisation is being given up.
      */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={!!active.isRefetching}
            onRefresh={() => active.refetch()}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.banners}>
          <TaskBanners />
        </View>

        {/* Tab bar and the New-PO action stay FULL WIDTH above the grid. */}
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

        {!active.isLoading && data.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState
              icon="file-tray-outline"
              title={search ? 'Nothing matches' : EMPTY_TITLE[tab]}
              message={search ? 'Try a different search.' : EMPTY_BODY[tab]}
            />
          </View>
        ) : null}

        <View style={styles.grid}>
          {data.map((item) => {
            // `data` is the union of the four shapes; the active tab is what
            // decides which one this is, so each branch narrows it explicitly.
            if (tab === 'po') return <PoCard key={item.id} row={item as SmPoRow} navigation={navigation} />;
            if (tab === 'inventory')
              return <InventoryCard key={item.id} row={item as InventoryItem} navigation={navigation} />;
            if (tab === 'audit')
              return <AuditCard key={item.id} row={item as AuditHistoryRow} navigation={navigation} />;
            return <RequestCard key={item.id} row={item as MaterialRequestRow} navigation={navigation} />;
          })}
        </View>
      </ScrollView>
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
// Cards
//
// Two per row, matching the shape of the navigation grid on every other
// dashboard: tinted icon well and a status pill on the top line, then the
// identifier, then context. `RecordCard` owns that shell so the four tabs cannot
// drift apart, and it lives HERE rather than beside MasterCard because the grid
// for record lists is a Store-Manager-only exception.
//
// At half width the constraint is real: every text node is capped with
// numberOfLines so a long supplier name truncates instead of pushing the card
// taller than its neighbour and breaking the row's alignment.
// ---------------------------------------------------------------------------

interface RecordCardProps {
  icon: keyof typeof Ionicons.glyphMap;
  /** Coral reads as "needs attention", teal as routine — same rule as MasterCard. */
  tone?: 'neutral' | 'attention';
  /** Top-right pill: the one status that matters most at a glance. */
  pill?: { label: string; color: string };
  /** The identifier. Always mono, always the most prominent thing on the card. */
  code: string;
  lines: (string | null | undefined)[];
  /** Optional figure shown large at the foot — a quantity, a total. */
  metric?: { text: string; alert?: boolean };
  /** Second pill at the foot, for a lifecycle state distinct from `pill`. */
  footPill?: { label: string; color: string };
  onPress?: () => void;
}

function RecordCard({
  icon, tone = 'neutral', pill, code, lines, metric, footPill, onPress,
}: RecordCardProps) {
  const wellBg = tone === 'attention' ? colors.tintCoral : colors.tintTeal;
  const wellInk = tone === 'attention' ? colors.accent : colors.primary;
  const body = lines.filter(Boolean) as string[];

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={[code, ...body, pill?.label, footPill?.label, metric?.text]
        .filter(Boolean)
        .join('. ')}
      style={({ pressed }) => [styles.card, pressed && onPress && styles.cardPressed]}
    >
      <View style={styles.cardTop}>
        <View style={[styles.iconWell, { backgroundColor: wellBg }]}>
          <Ionicons name={icon} size={18} color={wellInk} />
        </View>
        {pill ? <StatusPill label={pill.label} color={pill.color} /> : null}
      </View>

      <View style={styles.cardBody}>
        <Text style={styles.code} numberOfLines={1} ellipsizeMode="tail">
          {code}
        </Text>
        {body.map((l, i) => (
          <Text key={i} style={styles.sub} numberOfLines={2} ellipsizeMode="tail">
            {l}
          </Text>
        ))}
      </View>

      {metric || footPill ? (
        <View style={styles.cardFoot}>
          {footPill ? <StatusPill label={footPill.label} color={footPill.color} /> : null}
          {metric ? (
            <Text
              style={[styles.qty, metric.alert && { color: colors.alert }]}
              numberOfLines={1}
            >
              {metric.text}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function PoCard({ row, navigation }: { row: SmPoRow; navigation: any }) {
  const auto = row.origin === 'auto_shortfall';
  return (
    <RecordCard
      icon="document-text-outline"
      // A PO nobody has raised yet is the one that needs attention.
      tone={row.status === 'draft' || row.status === 'auto_generated' ? 'attention' : 'neutral'}
      // Origin first: the two kinds behave differently and that is the thing to
      // know at a glance. The lifecycle state gets the foot pill.
      pill={{ label: auto ? 'Auto' : 'Manual', color: auto ? colors.primary : colors.accent }}
      code={row.po_code}
      lines={[
        row.supplier_name ?? 'No supplier yet',
        [row.order_code, `${row.line_count} line${row.line_count === 1 ? '' : 's'}`,
         row.assigned_to].filter(Boolean).join(' · '),
      ]}
      footPill={{ label: PO_STATUS_LABEL[row.status] ?? row.status, color: colors.slate }}
      onPress={() => navigation.navigate('PoDetail', { poId: row.id })}
    />
  );
}

function InventoryCard({ row, navigation }: { row: InventoryItem; navigation: any }) {
  const low = row.reorder_threshold != null && Number(row.quantity) < Number(row.reorder_threshold);
  const out = Number(row.quantity) <= 0;
  return (
    <RecordCard
      icon={TYPE_ICON[row.item_type]}
      tone={low || out ? 'attention' : 'neutral'}
      pill={{
        label: row.source === 'po' ? 'PO' : 'Manual',
        color: row.source === 'po' ? colors.primary : colors.slate,
      }}
      code={row.color_code}
      lines={[
        [ITEM_TYPE_LABEL[row.item_type],
         row.size_mm ? `${row.size_mm} mm` : null,
         row.sequin_type].filter(Boolean).join(' · '),
        row.color_name,
      ]}
      metric={{
        text: `${Number(row.quantity).toLocaleString()} ${row.unit}`,
        alert: low || out,
      }}
      onPress={() => navigation.navigate('StockLedger', { colorCode: row.color_code })}
    />
  );
}

function AuditCard({ row, navigation }: { row: AuditHistoryRow; navigation: any }) {
  const date = new Date(row.audit_date + 'T00:00:00');
  const clean = row.corrected === 0;
  return (
    <RecordCard
      icon="checkmark-done-outline"
      tone={clean ? 'neutral' : 'attention'}
      // Weekly rows are the legacy audits, worth distinguishing in the history.
      pill={row.audit_type === 'weekly' ? { label: 'Weekly', color: colors.slate } : undefined}
      // Mono, per the brief — the date IS this record's identifier.
      code={date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })}
      lines={[
        `${row.item_count} item${row.item_count === 1 ? '' : 's'} counted`,
        row.conducted_by,
      ]}
      footPill={{
        label: clean ? 'All correct' : `${row.corrected} corrected`,
        color: clean ? colors.primary : colors.accent,
      }}
      onPress={() => navigation.navigate('AuditDetail', { auditId: row.id, code: row.audit_code })}
    />
  );
}

function RequestCard({ row, navigation }: { row: MaterialRequestRow; navigation: any }) {
  // A job-card request the store still owes opens the screen that issues it.
  // Everything else is history: the store manager has no order-detail route
  // registered, so making those cards pressable would navigate to nothing.
  const actionable = row.status === 'pending' && row.origin === 'job_card' && !!row.job_card_id;
  return (
    <RecordCard
      icon={row.origin === 'auto_stock_ready' ? 'cube-outline' : 'hand-left-outline'}
      tone={row.status === 'pending' ? 'attention' : 'neutral'}
      pill={{
        label: row.status === 'pending' ? 'Waiting' : row.status === 'issued' ? 'Issued' : 'Done',
        color: REQUEST_STATUS_COLOR[row.status] ?? colors.slate,
      }}
      code={row.order_code}
      lines={[
        row.origin === 'auto_stock_ready' ? 'Material ready in store' : 'Asked for by the floor',
        [row.vendor_name, new Date(row.requested_at).toLocaleDateString()]
          .filter(Boolean).join(' · '),
      ]}
      onPress={
        actionable
          ? () =>
              navigation.navigate('IssueDetail', {
                jobCardId: row.job_card_id,
                orderCode: row.order_code,
              })
          : undefined
      }
    />
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
  scroll: { paddingBottom: spacing.xxl },
  // The two-column grid. `gap` rather than per-card margins so the last row
  // stays aligned with the ones above it however many cards it holds — the same
  // arrangement CardGrid uses on every other dashboard.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  card: {
    // Just under half so two fit either side of one gap without rounding
    // overflow. NOT flex: 1 — an odd final card would stretch to full width and
    // stop reading as part of a grid, which is the bug the dashboards already had.
    width: '48%',
    minHeight: 150,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardPressed: { backgroundColor: colors.pressed },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  cardBody: { flex: 1, gap: 2 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs },
  iconWell: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
