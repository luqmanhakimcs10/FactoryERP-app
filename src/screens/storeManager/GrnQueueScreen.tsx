/**
 * GRN Queue — procurement handovers awaiting confirmation of physical receipt.
 * Stock does not move until the store manager confirms, because until then
 * nobody has actually counted what arrived.
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
  Platform,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { StatusPill } from '../../components/ui/StatusPill';
import { listGrns } from '../../api/endpoints/inventory';
import { describeDbError } from '../../utils/errors';
import type { Grn } from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

const TABS = [
  { key: 'pending', label: 'To confirm', statuses: ['pending'] },
  { key: 'confirmed', label: 'Confirmed', statuses: ['confirmed'] },
] as const;

export function GrnQueueScreen() {
  const navigation = useNavigation<any>();
  const [tab, setTab] = useState<'pending' | 'confirmed'>('pending');
  const active = TABS.find((t) => t.key === tab)!;

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['grns', tab],
    queryFn: () => listGrns([...active.statuses]),
  });

  return (
    <Screen padded={false}>
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: tab === t.key, selected: tab === t.key }}
            {...(Platform.OS === 'web' ? ({ 'aria-checked': tab === t.key } as object) : {})}
            style={({ pressed }) => [styles.tab, tab === t.key && styles.tabOn, pressed && { opacity: 0.75 }]}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      ) : isError ? (
        <Text style={styles.emptyBody}>{describeDbError(error, 'GRN')}</Text>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(g) => g.id}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>
                {tab === 'pending' ? 'Nothing to confirm' : 'No confirmed receipts yet'}
              </Text>
              <Text style={styles.emptyBody}>
                {tab === 'pending'
                  ? 'GRNs appear here when procurement hands goods over.'
                  : 'Confirmed receipts will be listed here.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <GrnRow grn={item} onPress={() => navigation.navigate('GrnDetail', { grnId: item.id })} />
          )}
        />
      )}
    </Screen>
  );
}

function GrnRow({ grn, onPress }: { grn: Grn; onPress: () => void }) {
  const lines = grn.grn_items?.length ?? 0;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.code}>{grn.grn_code}</Text>
        <StatusPill
          label={grn.status === 'pending' ? 'Awaiting receipt' : 'Received'}
          color={grn.status === 'pending' ? colors.warning : colors.success}
        />
      </View>
      <Text style={styles.supplier} numberOfLines={1}>
        {grn.purchase_orders?.suppliers?.name ?? 'Supplier not set'}
        {grn.purchase_orders?.po_code ? ` · ${grn.purchase_orders.po_code}` : ''}
      </Text>
      <Text style={styles.meta}>
        {lines} line{lines === 1 ? '' : 's'} · handed over{' '}
        {new Date(grn.handed_over_at).toLocaleDateString()}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg },
  tab: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  tabText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    fontWeight: fontWeight.medium,
  },
  tabTextOn: { color: colors.white, fontWeight: fontWeight.semibold },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  supplier: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { padding: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
