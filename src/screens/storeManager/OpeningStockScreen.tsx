/**
 * Opening Stock Entry — one time per factory, at deployment.
 *
 * Gated on `factories.opening_stock_completed_at`, not on "is thread_stock
 * empty". Emptiness is not a safe test: a factory could delete rows years into
 * production and silently re-open this screen, overwriting real counts. The
 * database refuses a second run regardless of what the UI does.
 *
 * The entry goes through the same ledger as everything else, so the running sum
 * of movements starts from a real opening balance rather than from nothing.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { StitchLine } from '../../components/ui/StitchLine';
import { getOpeningStockState, submitOpeningStock } from '../../api/endpoints/inventory';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
} from '../../constants/theme';

interface LineDraft {
  color_code: string;
  quantity_meters: string;
}

const EMPTY: LineDraft = { color_code: '', quantity_meters: '' };

export function OpeningStockScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY }]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const { data: state, isLoading } = useQuery({
    queryKey: ['openingStock', profile?.factory_id],
    queryFn: () => getOpeningStockState(profile!.factory_id as string),
    enabled: !!profile?.factory_id,
  });

  const submitMutation = useMutation({
    mutationFn: () =>
      submitOpeningStock(
        lines.map((l) => ({
          color_code: l.color_code.trim().toUpperCase(),
          quantity_meters: Number(l.quantity_meters),
        }))
      ),
    onSuccess: () => {
      setDone(true);
      for (const k of ['threadStock', 'openingStock', 'stockLedger']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
    },
    onError: (e) => setError(describeDbError(e, 'Opening stock')),
  });

  if (isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  // Already done: show why, and offer no way to run it again.
  if (state?.completed && !done) {
    return (
      <Screen>
        <View style={styles.lockWrap}>
          <Ionicons name="lock-closed-outline" size={36} color={colors.slate} />
          <Text style={styles.lockTitle}>Opening stock already recorded</Text>
          <Text style={styles.lockBody}>
            This factory completed its opening entry on{' '}
            {state.completedAt ? new Date(state.completedAt).toLocaleDateString() : 'an earlier date'}.
            It is a one-time step, so it cannot be run again — re-running it would
            overwrite real counts.
          </Text>
          <Text style={styles.lockBody}>
            To correct a quantity, use the Weekly Stock Audit: it records the
            change as a variance instead of silently replacing the figure.
          </Text>
          <AppButton
            title="Go to stock audit"
            onPress={() => navigation.replace('StockAudit')}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </Screen>
    );
  }

  function update(i: number, key: keyof LineDraft, v: string) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [key]: v } : l)));
  }

  function validate(): string | null {
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].color_code.trim().toUpperCase();
      if (!code) return `Line ${i + 1}: enter a colour code.`;
      if (seen.has(code)) return `Line ${i + 1}: ${code} is listed twice.`;
      seen.add(code);
      const qty = Number(lines[i].quantity_meters);
      if (!Number.isFinite(qty) || qty < 0) return `Line ${i + 1}: enter a quantity of zero or more.`;
    }
    return null;
  }

  if (done) {
    return (
      <Screen>
        <View style={styles.lockWrap}>
          <Ionicons name="checkmark-circle-outline" size={40} color={colors.success} />
          <Text style={styles.lockTitle}>Opening stock recorded</Text>
          <Text style={styles.lockBody}>
            {lines.length} colour{lines.length === 1 ? '' : 's'} seeded, each with an
            opening movement in the ledger. From here, stock changes only through
            receipts, issues and audits.
          </Text>
          <AppButton
            title="Back to stock"
            onPress={() => navigation.replace('RoleHome')}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Opening stock entry</Text>
        <Text style={styles.intro}>
          A one-time count at deployment. Enter what is physically on the shelf
          for each colour. This can only be done once — afterwards, corrections go
          through the weekly audit.
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {lines.map((line, i) => (
          <View key={i} style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Colour {i + 1}</Text>
              {lines.length > 1 ? (
                <Pressable
                  onPress={() => setLines((p) => p.filter((_, idx) => idx !== i))}
                  accessibilityLabel={`Remove colour ${i + 1}`}
                  accessibilityRole="button"
                  hitSlop={8}
                  style={({ pressed }) => [styles.remove, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.alert} />
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
            <TextField
              label="Thread colour code"
              value={line.color_code}
              onChangeText={(v) => update(i, 'color_code', v)}
              placeholder="RED-01"
              required
              mono
            />
            <TextField
              label="Quantity on hand (metres)"
              value={line.quantity_meters}
              onChangeText={(v) => update(i, 'quantity_meters', v)}
              placeholder="250000"
              required
              numeric
              mono
            />
          </View>
        ))}

        <Pressable
          onPress={() => setLines((p) => [...p, { ...EMPTY }])}
          accessibilityRole="button"
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="add" size={22} color={colors.indigoDeep} />
          <Text style={styles.addText}>Add colour</Text>
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <ActionBanner
          title="This runs once"
          subtitle="Check the figures before submitting. The entry is locked afterwards so a later mistake cannot wipe out real counts."
          style={styles.bannerGap}
        />

        <AppButton
          title="Record opening stock"
          onPress={() => {
            setError(null);
            const problem = validate();
            if (problem) {
              setError(problem);
              return;
            }
            submitMutation.mutate();
          }}
          loading={submitMutation.isPending}
        />
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
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  removeText: { color: colors.alert, fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 56,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.brass,
    backgroundColor: colors.tintTeal,
    marginBottom: spacing.lg,
  },
  addText: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
  lockWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  lockTitle: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep, textAlign: 'center' },
  lockBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center', lineHeight: 20 },
});
