/**
 * GRN Detail → Confirm Receipt.
 *
 * Each line is editable down from the expected quantity, because short
 * deliveries are normal and only what actually arrived may touch stock. On
 * confirm, every thread line writes a `grn` movement and raises the balance —
 * both in the same transaction, so stock can never rise without a ledger entry.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import { getGrn, confirmGrn } from '../../api/endpoints/inventory';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Alert } = require('react-native');
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm', onPress: onConfirm },
  ]);
}

export function GrnDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const grnId: string = route.params?.grnId;

  const [received, setReceived] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ lines_received: number } | null>(null);

  const { data: grn, isLoading } = useQuery({
    queryKey: ['grn', grnId],
    queryFn: () => getGrn(grnId),
  });

  // Default every line to the expected amount; the manager edits only shortfalls.
  useEffect(() => {
    if (!grn?.grn_items || Object.keys(received).length) return;
    const init: Record<string, string> = {};
    for (const it of grn.grn_items) init[it.id] = String(it.received_meters ?? it.expected_meters);
    setReceived(init);
  }, [grn]);

  const confirmMutation = useMutation({
    mutationFn: () =>
      confirmGrn(
        grnId,
        (grn?.grn_items ?? []).map((it) => ({
          grn_item_id: it.id,
          received_meters: Number(received[it.id] ?? it.expected_meters) || 0,
        }))
      ),
    onSuccess: (r) => {
      setResult(r);
      for (const k of ['grns', 'grn', 'threadStock', 'stockLedger', 'purchaseOrders']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
    },
    onError: (e) => setError(describeDbError(e, 'GRN')),
  });

  if (isLoading || !grn) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const items = grn.grn_items ?? [];
  const isPending = grn.status === 'pending';
  const anyShort = items.some(
    (it) => Number(received[it.id] ?? it.expected_meters) < Number(it.expected_meters)
  );

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{grn.grn_code}</Text>
          <StatusPill
            label={isPending ? 'Awaiting receipt' : 'Received'}
            color={isPending ? colors.warning : colors.success}
          />
        </View>
        <Text style={styles.supplier}>
          {grn.purchase_orders?.suppliers?.name ?? 'Supplier not set'}
          {grn.purchase_orders?.po_code ? ` · ${grn.purchase_orders.po_code}` : ''}
        </Text>
        {grn.note ? <Text style={styles.meta}>{grn.note}</Text> : null}

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {result ? (
          <ActionBanner
            tone="neutral"
            title="Receipt confirmed"
            subtitle={`${result.lines_received} thread line${result.lines_received === 1 ? '' : 's'} added to stock, each with a receipt movement logged against this GRN.`}
            style={styles.bannerGap}
          />
        ) : null}

        <Text style={styles.sectionTitle}>Lines</Text>

        {items.map((it) => {
          const expected = Number(it.expected_meters);
          const got = Number(received[it.id] ?? it.received_meters);
          const short = got < expected;
          return (
            <View key={it.id} style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={[styles.cardTitle, it.color_code ? styles.mono : null]}>
                  {it.color_code ?? it.description}
                </Text>
                {!it.color_code ? (
                  <StatusPill label="Non-thread" color={colors.slate} />
                ) : short && isPending ? (
                  <StatusPill label="Short" color={colors.warning} />
                ) : null}
              </View>

              <Text style={styles.cardLine}>
                Expected <Text style={styles.mono}>{expected.toLocaleString()}</Text> m
              </Text>

              {isPending ? (
                <TextField
                  label="Received"
                  value={received[it.id] ?? String(expected)}
                  onChangeText={(v) => setReceived((p) => ({ ...p, [it.id]: v }))}
                  numeric
                  mono
                  placeholder={String(expected)}
                />
              ) : (
                <Text style={styles.cardLine}>
                  Received{' '}
                  <Text style={styles.mono}>{Number(it.received_meters).toLocaleString()}</Text> m
                </Text>
              )}

              {!it.color_code ? (
                <Text style={styles.hint}>
                  Non-thread items are recorded on the GRN but do not affect thread stock.
                </Text>
              ) : null}
            </View>
          );
        })}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {isPending && !result ? (
          <AppButton
            title="Confirm receipt"
            onPress={() =>
              confirmAction(
                'Confirm receipt',
                anyShort
                  ? 'Some lines are short of the expected quantity. Only the amounts entered will be added to stock.'
                  : 'The quantities shown will be added to thread stock and logged in the ledger.',
                () => {
                  setError(null);
                  confirmMutation.mutate();
                }
              )
            }
            loading={confirmMutation.isPending}
          />
        ) : (
          <AppButton
            title="Back to queue"
            variant="secondary"
            onPress={() => navigation.navigate('GrnQueue')}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  supplier: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.indigoDeep },
  meta: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  stitch: { marginVertical: spacing.lg },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.xs },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep, flexShrink: 1 },
  cardLine: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.sm },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  hint: { fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
});
