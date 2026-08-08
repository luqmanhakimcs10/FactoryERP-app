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
        openRequests: requests.filter((r) => r.status === 'pending').length,
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
  container: { padding: spacing.lg, paddingTop: spacing.xl },
  empty: {
    paddingTop: spacing.xl,
    color: colors.inkMuted,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
  error: { paddingTop: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
});
