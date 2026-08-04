/**
 * Screen 4 — Final Delivery Queue (Delivery Person).
 * Lists orders that have completed all finishing stages and passed final QA.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ListRow } from '../../components/lists/ListRow';
import { SearchBar } from '../../components/lists/SearchBar';
import { StatusPill } from '../../components/ui/StatusPill';
import { colors, spacing, fontSize, fontWeight } from '../../constants/theme';
import { listFinalDeliveryQueue } from '../../api/endpoints/finishing';
import type { FinalDeliveryItem } from '../../models/finishingTypes';

export function FinalDeliveryQueueScreen({ navigation }: any) {
  const [orders, setOrders] = useState<FinalDeliveryItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const data = await listFinalDeliveryQueue();
      setOrders(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load final delivery queue.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const filtered = orders.filter(
    (o) =>
      o.order_code.toLowerCase().includes(search.toLowerCase()) ||
      o.vendor_name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Screen style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Final Delivery Queue</Text>
        <Text style={styles.subtitle}>
          Completed orders ready for vendor delivery & sign-off
        </Text>
      </View>

      <SearchBar value={search} onChangeText={setSearch} placeholder="Search order code, vendor..." />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.order_id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                loadData();
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No orders currently ready for final delivery</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.order_code}
              subtitle={`Vendor: ${item.vendor_name} • Repeats: ${item.completed_repeats}/${item.total_repeats}`}
              caption={`Created: ${new Date(item.created_at).toLocaleDateString()}`}
              rightNode={<StatusPill label="Ready for Delivery" color={colors.success} />}
              onPress={() => navigation.navigate('FinalDelivery', { item })}
            />
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { marginBottom: spacing.sm },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  subtitle: { fontSize: fontSize.secondary, color: colors.slate, marginTop: 2 },
  error: { color: colors.alert, marginVertical: spacing.sm },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { color: colors.slate, fontSize: fontSize.body },
});
