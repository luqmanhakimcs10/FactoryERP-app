/**
 * The Store Manager's four SECTIONS, reached from the 2x2 dashboard grid.
 *
 * THE SHAPE, AND WHY IT IS THIS WAY
 * ---------------------------------
 * Floor Manager is the pattern: a dashboard of big navigation cards, and inside
 * each card a plain single-column list of records. `MasterCard`'s own header
 * states the rule — grid layout is for NAVIGATION MENU CARDS, row layout is for
 * lists of RECORDS inside a section.
 *
 * An earlier pass put the records themselves into a two-column grid. That was a
 * misreading and is reverted here: these rows are the originals, recovered from
 * the commit before that change rather than retyped, so no wording, count,
 * status colour or destination has drifted.
 *
 * Each section owns its own screen so the dashboard can stay a dashboard —
 * nothing here is new behaviour, only the same lists behind a card instead of a
 * pill tab.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
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

const TYPE_ICON: Record<ItemType, keyof typeof Ionicons.glyphMap> = {
  thread: 'git-commit-outline',
  tilla: 'sparkles-outline',
  sequin: 'ellipse-outline',
  bobbin: 'reload-outline',
};

/** Human wording for a PO's lifecycle state — the list shows these, not the enum. */
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

/**
 * One shell for all four sections: search, pull-to-refresh, loading, error and
 * empty handled once. Only the header block and the row renderer differ, which
 * is the whole difference between the four.
 */
function SectionList<T extends { id: string }>({
  query,
  rows,
  renderRow,
  searchPlaceholder,
  emptyTitle,
  emptyBody,
  header,
  search,
  onSearch,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; isRefetching: boolean; refetch: () => void };
  rows: T[];
  renderRow: (item: T) => React.ReactElement;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyBody: string;
  header?: React.ReactNode;
  search: string;
  onSearch: (v: string) => void;
}) {
  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        // react-native-web's windowing never advanced past the first batch on
        // these lists, so long inventories silently stopped at ten rows.
        initialNumToRender={30}
        windowSize={21}
        removeClippedSubviews={false}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={query.refetch}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.searchWrap}>
              <SearchBar value={search} onChangeText={onSearch} placeholder={searchPlaceholder} />
            </View>
            {header}
            {query.isLoading ? <Loading /> : null}
            {query.isError ? (
              <Text style={styles.error}>{describeDbError(query.error, 'Store')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !query.isLoading ? (
            <View style={{ padding: spacing.xl }}>
              <EmptyState
                icon="file-tray-outline"
                title={search ? 'Nothing matches' : emptyTitle}
                message={search ? 'Try a different search.' : emptyBody}
              />
            </View>
          ) : null
        }
        renderItem={({ item }) => renderRow(item)}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 1. PO
// ---------------------------------------------------------------------------
export function StorePoSectionScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['smPos'], queryFn: listStorePos });
  const rows = (query.data ?? []).filter((p) =>
    matchesSearch(search, p.po_code, p.supplier_name, p.order_code, p.assigned_to)
  );

  return (
    <SectionList
      query={query}
      rows={rows}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search PO, supplier or order"
      emptyTitle="No purchase orders"
      emptyBody="One is raised automatically when an order is short of stock, or you can create one."
      header={
        <View style={styles.headerBlock}>
          <AppButton
            title="New purchase order"
            icon="add-circle-outline"
            onPress={() => navigation.navigate('StoreNewPo')}
          />
        </View>
      }
      renderRow={(item) => <PoRow row={item} navigation={navigation} />}
    />
  );
}

// ---------------------------------------------------------------------------
// 2. Inventory
// ---------------------------------------------------------------------------
export function StoreInventorySectionScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['inventoryItems'], queryFn: () => listInventory() });
  const rows = (query.data ?? []).filter((i) =>
    matchesSearch(search, i.color_code, i.color_name, ITEM_TYPE_LABEL[i.item_type])
  );

  return (
    <SectionList
      query={query}
      rows={rows}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search colour or type"
      emptyTitle="No stock recorded"
      emptyBody="Add thread, tilla, sequin or bobbin stock to get started."
      header={
        <View style={styles.headerBlock}>
          <AppButton
            title="Add stock"
            icon="add-circle-outline"
            onPress={() => navigation.navigate('AddInventory')}
          />
        </View>
      }
      renderRow={(item) => <InventoryRow row={item} navigation={navigation} />}
    />
  );
}

// ---------------------------------------------------------------------------
// 3. Audit
// ---------------------------------------------------------------------------
export function StoreAuditSectionScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');
  const today = useQuery({ queryKey: ['auditToday'], queryFn: getAuditTodayState });
  const query = useQuery({ queryKey: ['auditHistory'], queryFn: () => getAuditHistory() });
  const rows = (query.data ?? []).filter((a) => matchesSearch(search, a.audit_code));

  return (
    <SectionList
      query={query}
      rows={rows}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search audit code"
      emptyTitle="No audits yet"
      emptyBody="Do today’s audit and it will appear here."
      header={
        <View style={styles.headerBlock}>
          {/* The brief's "mandatory" is a visible nudge, not a lock on anything
              else — see 0072's header for why. */}
          {today.data?.done ? (
            <ActionBanner
              tone="neutral"
              title="Today's audit is done"
              subtitle={`${today.data.item_count ?? 0} items counted — ${today.data.audit_code ?? ''}`}
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
      }
      renderRow={(item) => <AuditRow row={item} navigation={navigation} />}
    />
  );
}

// ---------------------------------------------------------------------------
// 4. Requests
// ---------------------------------------------------------------------------
export function StoreRequestsSectionScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');
  const query = useQuery({ queryKey: ['materialRequests'], queryFn: getMaterialRequestHistory });
  const issueQueue = useQuery({ queryKey: ['issueQueue'], queryFn: getMaterialIssueQueue });
  const rows = (query.data ?? []).filter((r) =>
    matchesSearch(search, r.request_code, r.order_code, r.vendor_name)
  );

  return (
    <SectionList
      query={query}
      rows={rows}
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search request or order"
      emptyTitle="No material requests"
      emptyBody="Requests appear here as the floor asks for material."
      header={
        (issueQueue.data?.length ?? 0) > 0 ? (
          <View style={styles.headerBlock}>
            <ActionBanner
              title={`${issueQueue.data!.length} request${
                issueQueue.data!.length === 1 ? '' : 's'
              } to issue`}
              subtitle="The floor cannot start production until these go out"
              onPress={() => navigation.navigate('MaterialIssueQueue')}
            />
          </View>
        ) : null
      }
      renderRow={(item) => <RequestRow row={item} navigation={navigation} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Rows — recovered verbatim from before the item-grid change.
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
  searchWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  headerBlock: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
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
