/**
 * Weekly Stock Audit.
 *
 * An audit sheet of expected (system) vs actual (counted) per colour. On submit,
 * each difference writes an `audit_variance` movement and sets stock to the
 * counted figure — the physical count is the truth, and the variance is the
 * leakage signal Phase 7's report reads.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import { listThreadStock, submitStockAudit, listStockAudits } from '../../api/endpoints/inventory';
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

export function StockAuditScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();

  const [counted, setCounted] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ audit_code: string; variances: number } | null>(null);

  const { data: stock, isLoading } = useQuery({
    queryKey: ['threadStock', ''],
    queryFn: () => listThreadStock(),
  });
  const { data: history } = useQuery({
    queryKey: ['stockAudits'],
    queryFn: listStockAudits,
  });

  // Pre-fill with the system figure so only real differences need typing.
  useEffect(() => {
    if (!stock?.length || Object.keys(counted).length) return;
    const init: Record<string, string> = {};
    for (const s of stock) init[s.color_code] = String(s.quantity_meters);
    setCounted(init);
  }, [stock]);

  const submitMutation = useMutation({
    mutationFn: () =>
      submitStockAudit(
        (stock ?? []).map((s) => ({
          color_code: s.color_code,
          actual_meters: Number(counted[s.color_code] ?? s.quantity_meters) || 0,
        })),
        note.trim() || null
      ),
    onSuccess: (r) => {
      setResult(r);
      for (const k of ['threadStock', 'stockLedger', 'stockAudits']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
    },
    onError: (e) => setError(describeDbError(e, 'Stock audit')),
  });

  if (isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const rows = stock ?? [];
  const variances = rows.filter(
    (s) => Number(counted[s.color_code] ?? s.quantity_meters) !== Number(s.quantity_meters)
  );

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Weekly stock audit</Text>
        <Text style={styles.intro}>
          Count each colour and enter the actual figure. Anything different from
          the system count is recorded as a variance and stock is set to what you
          counted.
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {result ? (
          <ActionBanner
            tone="neutral"
            title={`Audit submitted · ${result.audit_code}`}
            subtitle={
              result.variances === 0
                ? 'Every colour matched the system count.'
                : `${result.variances} colour(s) differed; each variance is logged in the ledger.`
            }
            style={styles.bannerGap}
          />
        ) : null}

        {rows.length === 0 ? (
          <Text style={styles.emptyBody}>No stock to audit yet.</Text>
        ) : null}

        {rows.map((s) => {
          const actual = Number(counted[s.color_code] ?? s.quantity_meters);
          const expected = Number(s.quantity_meters);
          const variance = actual - expected;
          return (
            <View key={s.id} style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.colorCode}>{s.color_code}</Text>
                {variance !== 0 ? (
                  <StatusPill
                    label={`${variance > 0 ? '+' : ''}${variance.toLocaleString()} m`}
                    color={variance < 0 ? colors.alert : colors.warning}
                  />
                ) : (
                  <StatusPill label="Matches" color={colors.success} />
                )}
              </View>
              <Text style={styles.expected}>
                System expects <Text style={styles.mono}>{expected.toLocaleString()}</Text> m
              </Text>
              {!result ? (
                <TextField
                  label="Counted"
                  value={counted[s.color_code] ?? String(expected)}
                  onChangeText={(v) => setCounted((p) => ({ ...p, [s.color_code]: v }))}
                  numeric
                  mono
                />
              ) : null}
            </View>
          );
        })}

        {!result && rows.length ? (
          <TextField
            label="Audit note"
            value={note}
            onChangeText={setNote}
            placeholder="e.g. Counted with Imran, Friday close"
            multiline
          />
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {!result && rows.length ? (
          <AppButton
            title="Submit audit"
            onPress={() =>
              confirmAction(
                'Submit stock audit',
                variances.length
                  ? `${variances.length} colour(s) differ from the system count. Stock will be set to your counted figures and each variance logged.`
                  : 'All counts match the system. The audit will be recorded with no stock change.'
              , () => {
                  setError(null);
                  submitMutation.mutate();
                }
              )
            }
            loading={submitMutation.isPending}
          />
        ) : null}

        {result ? (
          <AppButton
            title="Back to stock"
            variant="secondary"
            onPress={() => navigation.navigate('RoleHome')}
          />
        ) : null}

        {history?.length ? (
          <View style={styles.history}>
            <Text style={styles.sectionTitle}>Past audits</Text>
            {history.slice(0, 5).map((a) => {
              const varied = (a.stock_audit_items ?? []).filter(
                (i) => Number(i.variance_meters) !== 0
              ).length;
              return (
                <View key={a.id} style={styles.historyRow}>
                  <Text style={styles.mono}>{a.audit_code}</Text>
                  <Text style={styles.meta}>
                    {new Date(a.submitted_at).toLocaleDateString()} ·{' '}
                    {a.stock_audit_items?.length ?? 0} counted · {varied} variance
                    {varied === 1 ? '' : 's'}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  intro: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  stitch: { marginVertical: spacing.lg },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  colorCode: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  expected: { marginTop: spacing.xs, marginBottom: spacing.sm, fontSize: fontSize.secondary, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center', paddingVertical: spacing.lg },
  history: { marginTop: spacing.xxl, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  historyRow: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  meta: { fontSize: fontSize.caption, color: colors.slate },
});
