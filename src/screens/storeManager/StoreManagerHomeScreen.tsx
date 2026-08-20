/**
 * Store Manager Dashboard — four navigation sections, as a 2x2 grid.
 *
 * Structurally identical to FloorManagerDashboardScreen, deliberately: same
 * `MasterCard` grid layout, same `CardGrid`, same header, same search-over-cards
 * behaviour. Copying the pattern rather than approximating it is the point — two
 * dashboards meant to look the same should be built the same way.
 *
 * These are NAVIGATION MENU CARDS (tap to go elsewhere). The actual records —
 * POs, inventory items, audit history, requests — live inside each section as
 * single-column rows, which is the distinction `MasterCard`'s own header draws.
 *
 * WHAT THIS REPLACED
 * Two earlier shapes, both wrong. First a pill tab bar with the record list
 * directly beneath it, which made four sections read as one screen with filters.
 * Then those records as a two-column card grid, which pushed the grid one level
 * too deep. The grid belongs at the top level only.
 *
 * Counts, labels and subtitles carry over from the tab bar they replace.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { MasterCard, CardGrid, type MasterCardProps } from '../../components/ui/MasterCard';
import { MetricCard, MetricRow, MetricsSection } from '../../components/ui/MetricCard';
import { statCount } from '../../utils/statValue';
import { matchesSearch } from '../../utils/search';
import {
  listStorePos,
  listInventory,
  getAuditTodayState,
  getMaterialRequestHistory,
} from '../../api/endpoints/storeManager';
import { colors, spacing, fontSize } from '../../constants/theme';

export function StoreManagerHomeScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

  const { data, isError } = useQuery({
    queryKey: ['storeManagerCardCounts'],
    queryFn: async () => {
      const [pos, inventory, audit, requests] = await Promise.all([
        listStorePos(),
        listInventory(),
        getAuditTodayState(),
        getMaterialRequestHistory(),
      ]);
      return {
        // The same numbers the pill tabs carried: OPEN POs, not every PO ever.
        openPos: pos.filter((p) => !['received', 'cancelled'].includes(p.status)).length,
        items: inventory.length,
        auditDone: !!audit.done,
        /*
         * DIRECTED TO THE STORE MANAGER, not every pending row.
         *
         * `material_request_history` returns the whole table, and most pending
         * rows are `auto_stock_ready` ones aimed at the FLOOR manager — the
         * "your material is already in stock" notice. Counting those put the
         * floor's queue on the store's dashboard: 21 against the 1 request
         * actually waiting on this role.
         */
        openRequests: requests.filter(
          (r) => r.status === 'pending' && r.directed_to === 'store_manager'
        ).length,
        // "In progress" in the 0089 sense: bought or still to buy, not yet paid.
        posInProgress: pos.filter((p) =>
          ['auto_generated', 'draft', 'procured'].includes(p.status)
        ).length,
        // An item is low when it has a threshold and has fallen under it. Items
        // with no threshold are not low — they are unmonitored, which is a
        // different problem and not one a count can state.
        lowStock: inventory.filter(
          (i) => i.reorder_threshold != null && Number(i.quantity) < Number(i.reorder_threshold)
        ).length,
      };
    },
  });

  const cards: (MasterCardProps & { key: string })[] = [
    {
      key: 'po',
      label: 'PO',
      subtitle: 'Purchase orders, automatic and manual',
      icon: 'document-text-outline',
      accent: colors.primary,
      count: data?.openPos ?? null,
      onPress: () => navigation.navigate('StorePoSection'),
    },
    {
      key: 'inventory',
      label: 'Inventory',
      subtitle: 'Thread, tilla, sequin and bobbin stock',
      icon: 'cube-outline',
      accent: colors.primary,
      count: data?.items ?? null,
      onPress: () => navigation.navigate('StoreInventorySection'),
    },
    {
      key: 'audit',
      label: 'Audit',
      // Coral while today's count is outstanding, teal once done — the same
      // "needs attention" reading the other dashboards use, and the brief's
      // mandatory-but-not-blocking nudge in its mildest form.
      subtitle: data?.auditDone ? 'Today’s count is done' : 'Today’s count is not done',
      icon: 'checkmark-done-outline',
      accent: data?.auditDone ? colors.primary : colors.accent,
      // One outstanding obligation, not a row count — 1 or 0, matching the
      // sm_audit_today banner rather than inventing a second meaning for it.
      count: data == null ? null : data.auditDone ? 0 : 1,
      onPress: () => navigation.navigate('StoreAuditSection'),
    },
    {
      key: 'requests',
      label: 'Requests',
      subtitle: 'Material the floor has asked for',
      icon: 'hand-left-outline',
      accent: colors.accent,
      count: data?.openRequests ?? null,
      onPress: () => navigation.navigate('StoreRequestsSection'),
    },
  ];

  const visible = useMemo(
    () => cards.filter((c) => matchesSearch(search, c.label, c.subtitle)),
    [search, data]
  );

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search sections"
        navigation={navigation}
      />
      <ScrollView contentContainerStyle={styles.container}>
        <TaskBanners />

        <MetricsSection subtitle="What the store owes the floor">
          <MetricRow>
            <MetricCard
              label="Pending material requests"
              value={statCount(data?.openRequests)}
              icon="cube-outline"
              accent={data?.openRequests ? 'amber' : 'teal'}
              onPress={() => navigation.navigate('StoreRequestsSection')}
            />
            <MetricCard
              label="POs in progress"
              value={statCount(data?.posInProgress)}
              icon="document-text-outline"
              accent="teal"
              onPress={() => navigation.navigate('StorePoSection')}
            />
            <MetricCard
              label="Low stock items"
              value={statCount(data?.lowStock)}
              icon="alert-circle-outline"
              accent={data?.lowStock ? 'rose' : 'green'}
              onPress={() => navigation.navigate('StoreInventorySection')}
            />
            <MetricCard
              // A yes/no, not a count — the brief asks for an indicator, and a
              // "1" here would read as one item audited.
              label="Today's audit"
              value={data === undefined ? '—' : data.auditDone ? 'Done' : 'Not done'}
              icon="checkmark-done-outline"
              accent={data && !data.auditDone ? 'rose' : 'green'}
              onPress={() => navigation.navigate('DailyAudit')}
            />
          </MetricRow>
        </MetricsSection>

        <CardGrid>
          {visible.map(({ key, ...card }) => (
            <MasterCard key={key} {...card} />
          ))}
        </CardGrid>

        {visible.length === 0 ? (
          <Text style={styles.empty}>No sections match “{search}”.</Text>
        ) : null}
        {isError ? <Text style={styles.error}>Unable to load counts.</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  metrics: { marginBottom: spacing.lg },
  container: { padding: spacing.lg, paddingTop: spacing.xl },
  empty: {
    paddingTop: spacing.xl,
    color: colors.inkMuted,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
  error: { paddingTop: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
});
