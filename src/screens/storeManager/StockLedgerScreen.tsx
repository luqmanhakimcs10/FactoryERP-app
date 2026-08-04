/**
 * Full movement history for one colour code.
 *
 * This is the human-readable form of the unified ledger: every row shows what
 * kind of movement it was, the signed quantity, the resulting balance, who did
 * it, when, and the GRN / issue / audit that caused it. The running balance is
 * the ledger's own `balance_after`, so if it ever disagreed with thread_stock
 * that would be visible here rather than hidden.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { StatusPill } from '../../components/ui/StatusPill';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { getStockLedger, listThreadStock, setReorderLevels } from '../../api/endpoints/inventory';
import { describeDbError } from '../../utils/errors';
import { MOVEMENT_LABEL, type MovementType } from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

const MOVEMENT_COLOR: Record<MovementType, string> = {
  opening: colors.slate,
  grn: colors.success,
  issue: colors.indigo,
  audit_variance: colors.warning,
};

export function StockLedgerScreen() {
  const route = useRoute<any>();
  const queryClient = useQueryClient();
  const colorCode: string = route.params?.colorCode;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['stockLedger', colorCode],
    queryFn: () => getStockLedger(colorCode),
  });
  const { data: stock } = useQuery({
    queryKey: ['threadStock', colorCode],
    queryFn: () => listThreadStock(colorCode),
  });

  const current = stock?.find((s) => s.color_code === colorCode);
  const rows = data ?? [];
  const sum = rows.reduce((n, r) => n + Number(r.quantity_meters), 0);
  const reconciles = current ? Math.abs(sum - Number(current.quantity_meters)) < 0.01 : true;

  const [threshold, setThreshold] = useState('');
  const [reorderQty, setReorderQty] = useState('');
  const [reorderError, setReorderError] = useState<string | null>(null);

  useEffect(() => {
    setThreshold(current?.reorder_threshold != null ? String(current.reorder_threshold) : '');
    setReorderQty(current?.reorder_quantity != null ? String(current.reorder_quantity) : '');
  }, [current?.reorder_threshold, current?.reorder_quantity]);

  const reorderMutation = useMutation({
    mutationFn: () =>
      setReorderLevels(
        colorCode,
        threshold.trim() ? Number(threshold) : null,
        reorderQty.trim() ? Number(reorderQty) : null
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threadStock'] });
    },
    onError: (e) => setReorderError(describeDbError(e, 'Reorder levels')),
  });

  return (
    <Screen padded={false}>
      <View style={styles.header}>
        <Text style={styles.color}>{colorCode}</Text>
        <Text style={styles.balance}>
          {Number(current?.quantity_meters ?? 0).toLocaleString()} m in stock
        </Text>
        {/* If this ever reads "does not reconcile", a movement was missed. */}
        <Text style={[styles.reconcile, !reconciles && { color: colors.alert }]}>
          {reconciles
            ? `Ledger reconciles across ${rows.length} movement${rows.length === 1 ? '' : 's'}`
            : `Ledger sums to ${sum.toLocaleString()} — does not reconcile`}
        </Text>

        <View style={styles.reorderBox}>
          <Text style={styles.reorderTitle}>Automatic reorder</Text>
          <Text style={styles.reorderHint}>
            When stock falls below the threshold, a purchase order is raised automatically —
            no manual trigger. Leave blank to disable for this colour.
          </Text>
          <View style={styles.reorderRow}>
            <View style={{ flex: 1 }}>
              <TextField label="Threshold (m)" value={threshold} onChangeText={setThreshold} numeric mono />
            </View>
            <View style={{ flex: 1 }}>
              <TextField label="Reorder to (m)" value={reorderQty} onChangeText={setReorderQty} numeric mono />
            </View>
          </View>
          {reorderError ? <Text style={styles.reorderError}>{reorderError}</Text> : null}
          <AppButton
            title="Save reorder levels"
            variant="secondary"
            loading={reorderMutation.isPending}
            onPress={() => {
              setReorderError(null);
              reorderMutation.mutate();
            }}
          />
        </View>
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      ) : isError ? (
        <Text style={styles.emptyBody}>{describeDbError(error, 'Ledger')}</Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(_, i) => String(i)}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyBody}>No movements recorded for this colour.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const qty = Number(item.quantity_meters);
            return (
              <View style={styles.row}>
                <View style={styles.rowTop}>
                  <StatusPill
                    label={MOVEMENT_LABEL[item.movement_type]}
                    color={MOVEMENT_COLOR[item.movement_type]}
                  />
                  <Text style={[styles.qty, qty < 0 ? styles.qtyOut : styles.qtyIn]}>
                    {qty > 0 ? '+' : ''}
                    {qty.toLocaleString()} m
                  </Text>
                </View>
                <Text style={styles.meta}>
                  Balance <Text style={styles.mono}>{Number(item.balance_after).toLocaleString()}</Text> m
                  {' · '}
                  {new Date(item.created_at).toLocaleString()}
                </Text>
                <Text style={styles.meta}>
                  {item.actor}
                  {item.ref_code ? (
                    <>
                      {' · '}
                      <Text style={styles.mono}>{item.ref_code}</Text>
                    </>
                  ) : null}
                </Text>
                {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { padding: spacing.xl, paddingBottom: spacing.lg },
  color: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  balance: { marginTop: spacing.xs, fontSize: fontSize.hero, fontFamily: fontFamily.mono, color: colors.indigoDeep },
  reconcile: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.success },
  reorderBox: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  reorderTitle: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  reorderHint: { marginTop: 2, marginBottom: spacing.sm, fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  reorderRow: { flexDirection: 'row', gap: spacing.md },
  reorderError: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
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
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  qty: { fontFamily: fontFamily.mono, fontSize: fontSize.body, fontWeight: fontWeight.medium },
  qtyIn: { color: colors.success },
  qtyOut: { color: colors.indigo },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  note: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
  center: { padding: spacing.xl, alignItems: 'center' },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
