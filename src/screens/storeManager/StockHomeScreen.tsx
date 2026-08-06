/**
 * Stock Home — the store manager's landing screen.
 *
 * Thread stock by colour code, with counters for the two queues they own, and
 * entry points to issue, audit and the one-time opening entry.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { ListRow } from '../../components/lists/ListRow';
import { MasterCard } from '../../components/ui/MasterCard';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
import {
  listThreadStock,
  listGrns,
  getMaterialIssueQueue,
  getOpeningStockState,
} from '../../api/endpoints/inventory';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export function StockHomeScreen() {
  const navigation = useNavigation<any>();
  const { profile } = useAuth();
  const [search, setSearch] = useState('');

  const { data: stock, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['threadStock', search],
    queryFn: () => listThreadStock(search),
  });
  const { data: pendingGrns } = useQuery({
    queryKey: ['grns', 'pending'],
    queryFn: () => listGrns(['pending']),
  });
  const { data: issueQueue } = useQuery({
    queryKey: ['issueQueue'],
    queryFn: getMaterialIssueQueue,
  });
  const { data: opening } = useQuery({
    queryKey: ['openingStock', profile?.factory_id],
    queryFn: () => getOpeningStockState(profile!.factory_id as string),
    enabled: !!profile?.factory_id,
  });

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search colour code"
        navigation={navigation}
      />
      <FlatList
        data={stock ?? []}
        keyExtractor={(s) => s.id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.banner}><TaskBanners /></View>

            <View style={styles.poBox}>
              {/* layout="row" deliberately: this is a single card, not a menu
                  of sections. A lone half-width tile beside empty space reads
                  as a broken grid rather than as a grid. */}
              <MasterCard
                layout="row"
                label="PO"
                subtitle="Handed over by procurement, awaiting receipt confirmation"
                icon="cube-outline"
                accent={colors.accent}
                count={pendingGrns?.length ?? null}
                onPress={() => navigation.navigate('GrnQueue')}
              />
            </View>

            <View style={styles.counters}>
              <StatGrid>
                <StatCard
                  label="Job cards to issue"
                  value={String(issueQueue?.length ?? 0)}
                  icon="clipboard-outline"
                  tone="attention"
                  onPress={() => navigation.navigate('MaterialIssueQueue')}
                />
              </StatGrid>
            </View>

            <View style={styles.actions}>
              <ListRow
                title="Weekly stock audit"
                subtitle="Count expected vs actual per colour"
                onPress={() => navigation.navigate('StockAudit')}
              />
              {!opening?.completed ? (
                <ListRow
                  title="Opening stock entry"
                  subtitle="One-time — seed initial quantities"
                  pillLabel="Not done"
                  pillColor={colors.warning}
                  onPress={() => navigation.navigate('OpeningStock')}
                />
              ) : null}
            </View>

            <Text style={styles.sectionTitle}>Thread stock</Text>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? (
              <Text style={styles.emptyBody}>{describeDbError(error, 'Stock')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No stock recorded</Text>
              <Text style={styles.emptyBody}>
                {opening?.completed
                  ? 'No colours match.'
                  : 'Start with the one-time Opening Stock Entry above.'}
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => navigation.navigate('StockLedger', { colorCode: item.color_code })}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.color}>{item.color_code}</Text>
              <Text style={styles.rowHint}>Tap for full movement history</Text>
            </View>
            <Text
              style={[
                styles.qty,
                Number(item.quantity_meters) <= 0 && { color: colors.alert },
              ]}
            >
              {Number(item.quantity_meters).toLocaleString()} m
            </Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: spacing.lg, marginTop: spacing.lg },
  poBox: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  counters: { padding: spacing.lg },
  actions: { paddingHorizontal: spacing.lg, marginBottom: spacing.lg },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
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
  color: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  rowHint: { fontSize: fontSize.caption, color: colors.slate },
  qty: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { paddingHorizontal: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
