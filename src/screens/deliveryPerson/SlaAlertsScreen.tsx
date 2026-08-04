/**
 * Screen 2 — SLA Alerts List.
 * Surfaces active SLA breaches to Delivery Person, Floor Manager, and QA.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, ActivityIndicator, Pressable } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ListRow } from '../../components/lists/ListRow';
import { StatusPill } from '../../components/ui/StatusPill';
import { colors, spacing, fontSize, fontWeight } from '../../constants/theme';
import { listSlaAlerts, triggerSlaCheck } from '../../api/endpoints/finishing';
import type { SlaAlertItem } from '../../models/finishingTypes';

export function SlaAlertsScreen({ navigation }: any) {
  const [alerts, setAlerts] = useState<SlaAlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      // Run scanner check to catch any recent breaches
      await triggerSlaCheck().catch(() => {});
      const data = await listSlaAlerts();
      setAlerts(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load SLA alerts.');
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

  return (
    <Screen style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>SLA Alerts ({alerts.length})</Text>
        <Text style={styles.subtitle}>
          Active finishing deadline breaches requiring immediate follow-up
        </Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading ? (
        <ActivityIndicator color={colors.alert} style={{ marginTop: spacing.xl }} />
      ) : (
        <FlatList
          data={alerts}
          keyExtractor={(item) => item.alert_id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                loadData();
              }}
              tintColor={colors.alert}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No active SLA breaches</Text>
              <Text style={styles.emptyText}>All stage handoffs are within expected SLA deadlines</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.repeat_code}
              subtitle={`Order: ${item.order_code} • Stage: ${item.stage_type} (${item.partner_name ?? 'In-house'})`}
              caption={`Triggered: ${new Date(item.triggered_at).toLocaleTimeString()}`}
              rightNode={
                <StatusPill
                  label={`${item.hours_overdue > 0 ? '+' + item.hours_overdue + 'h' : 'Overdue'}`}
                  color={colors.alert}
                />
              }
              onPress={() => {
                navigation.navigate('ReturnQueue');
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { marginBottom: spacing.md },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.alert },
  subtitle: { fontSize: fontSize.secondary, color: colors.slate, marginTop: 2 },
  error: { color: colors.alert, marginVertical: spacing.sm },
  empty: { padding: spacing.xl, alignItems: 'center', marginTop: spacing.lg },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyText: { color: colors.slate, fontSize: fontSize.secondary, marginTop: 4, textAlign: 'center' },
});
