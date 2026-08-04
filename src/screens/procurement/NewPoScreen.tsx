/**
 * Manually raise a purchase order.
 *
 * Phase 3's shortfall check only raises a PO when a specific order runs short.
 * This covers everything else a real store needs: buffer restock, replacing a
 * damaged cone, seasonal bulk buys, and non-thread consumables.
 *
 * Reuses the repeatable sub-card pattern from the sheet builder.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { SelectField } from '../../components/forms/SelectField';
import { StitchLine } from '../../components/ui/StitchLine';
import { listMasters } from '../../api/endpoints/masters';
import { listThreadStock, createManualPo } from '../../api/endpoints/inventory';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

interface LineDraft {
  color_code: string;
  description: string;
  quantity_meters: string;
}

const EMPTY_LINE: LineDraft = { color_code: '', description: '', quantity_meters: '' };

export function NewPoScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();

  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }]);
  const [error, setError] = useState<string | null>(null);

  const { data: suppliers, isLoading: loadingSuppliers } = useQuery({
    queryKey: ['masters', 'suppliers', '', false],
    queryFn: () => listMasters({ table: 'suppliers', searchField: 'name' }),
  });
  // Existing colours make restocking a known colour a tap rather than a retype.
  const { data: stock } = useQuery({
    queryKey: ['threadStock', ''],
    queryFn: () => listThreadStock(),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createManualPo({
        supplierId,
        notes: notes.trim() || null,
        items: lines.map((l) => ({
          color_code: l.color_code.trim().toUpperCase() || null,
          description: l.description.trim() || null,
          quantity_meters: Number(l.quantity_meters),
        })),
      }),
    onSuccess: (po) => {
      queryClient.invalidateQueries({ queryKey: ['purchaseOrders'] });
      navigation.replace('PoDetail', { poId: po.id });
    },
    onError: (e) => setError(describeDbError(e, 'Purchase order')),
  });

  function update(i: number, key: keyof LineDraft, v: string) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [key]: v } : l)));
  }

  function validate(): string | null {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.color_code.trim() && !l.description.trim()) {
        return `Line ${i + 1}: enter a colour code or a description.`;
      }
      const qty = Number(l.quantity_meters);
      if (!Number.isFinite(qty) || qty <= 0) {
        return `Line ${i + 1}: quantity must be greater than zero.`;
      }
    }
    return null;
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>New purchase order</Text>
        <Text style={styles.intro}>
          For restocking outside a specific order. Shortfall POs are raised
          automatically when an order is submitted.
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {loadingSuppliers ? (
          <ActivityIndicator color={colors.indigo} />
        ) : (
          <SelectField
            label="Supplier"
            value={supplierId}
            options={(suppliers ?? []).map((s: any) => ({ value: s.id, label: s.name }))}
            onChange={setSupplierId}
            allowClear
            clearLabel="Decide later"
            emptyHint="No suppliers on file yet — add one from Master data."
          />
        )}

        <Text style={styles.sectionTitle}>Lines</Text>

        {lines.map((line, i) => (
          <View key={i} style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Line {i + 1}</Text>
              {lines.length > 1 ? (
                <Pressable
                  onPress={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  accessibilityLabel={`Remove line ${i + 1}`}
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
              mono
            />
            {stock?.length ? (
              <View style={styles.suggestRow}>
                {stock.slice(0, 8).map((s) => (
                  <Pressable
                    key={s.id}
                    onPress={() => update(i, 'color_code', s.color_code)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.suggest, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={styles.suggestText}>{s.color_code}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <TextField
              label="Or a description (non-thread item)"
              value={line.description}
              onChangeText={(v) => update(i, 'description', v)}
              placeholder="e.g. Backing paper (roll)"
            />

            <TextField
              label="Quantity (metres / units)"
              value={line.quantity_meters}
              onChangeText={(v) => update(i, 'quantity_meters', v)}
              placeholder="5000"
              required
              numeric
              mono
            />
          </View>
        ))}

        <Pressable
          onPress={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
          accessibilityRole="button"
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
        >
          <Ionicons name="add" size={22} color={colors.indigoDeep} />
          <Text style={styles.addText}>Add line</Text>
        </Pressable>

        <TextField
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="e.g. Buffer restock before Eid season"
          multiline
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          <AppButton
            title="Cancel"
            variant="secondary"
            onPress={() => navigation.goBack()}
            disabled={createMutation.isPending}
            style={{ flex: 1 }}
          />
          <AppButton
            title="Raise PO"
            onPress={() => {
              setError(null);
              const problem = validate();
              if (problem) {
                setError(problem);
                return;
              }
              createMutation.mutate();
            }}
            loading={createMutation.isPending}
            style={{ flex: 1 }}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  intro: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
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
    marginBottom: spacing.lg,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  removeText: { color: colors.alert, fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: -spacing.md, marginBottom: spacing.lg },
  suggest: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    backgroundColor: colors.canvas,
  },
  suggestText: { fontFamily: fontFamily.mono, fontSize: fontSize.caption, color: colors.slate },
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
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
});
