/**
 * Handover to Store Manager — what came back after an order is finished.
 *
 * Everything issued for the order is listed. For each line the Floor Manager
 * either says how much is left over (which goes back into stock) or marks it as
 * still mounted on a machine (which does not).
 *
 * TWO SECTIONS, ONE SUBMIT
 * ------------------------
 * The brief asks for "On Machine" items to be shown separately from what is
 * being returned, and they are — but they are part of the same submission. They
 * have to be: the handover is a statement about ALL the material issued, and a
 * line silently missing from it is indistinguishable from a line nobody looked
 * at. Marking something as still-mounted is an answer, not an omission.
 *
 * Leftovers take decimals on purpose. 2.3 cones is two full cones and a
 * part-used third, and rounding that to 2 loses a third of a cone on every
 * order — which is exactly the leakage the stock ledger exists to surface.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { EmptyState, Loading } from '../../components/ui/States';
import { describeDbError } from '../../utils/errors';
import {
  getHandoverLines,
  submitHandover,
  ITEM_TYPE_LABEL,
  type HandoverLine,
} from '../../api/endpoints/storeManager';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

interface Entry {
  leftover: string;
  onMachine: boolean;
}

export function HandoverToStoreScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const qc = useQueryClient();
  const orderId = route.params?.orderId as string;
  const orderCode = route.params?.orderCode as string | undefined;

  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [note, setNote] = useState('');

  const q = useQuery({
    queryKey: ['handoverLines', orderId],
    queryFn: () => getHandoverLines(orderId),
    enabled: !!orderId,
  });
  const lines = useMemo(() => q.data ?? [], [q.data]);

  // Seed from what the database already knows is mounted, so the common case is
  // pre-answered and the user only corrects it.
  useEffect(() => {
    if (lines.length === 0) return;
    setEntries((prev) => {
      const next = { ...prev };
      for (const l of lines) {
        if (!next[l.inventory_item_id]) {
          next[l.inventory_item_id] = { leftover: '', onMachine: l.on_machine };
        }
      }
      return next;
    });
  }, [lines]);

  const submit = useMutation({
    mutationFn: () =>
      submitHandover(
        orderId,
        lines.map((l) => {
          const e = entries[l.inventory_item_id] ?? { leftover: '', onMachine: false };
          return {
            inventory_item_id: l.inventory_item_id,
            issued_quantity: Number(l.issued_quantity),
            leftover_quantity: e.onMachine ? 0 : Number(e.leftover || 0),
            on_machine: e.onMachine,
          };
        }),
        note.trim() || null
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['inventoryItems'] });
      qc.invalidateQueries({ queryKey: ['threadStock'] });
      qc.invalidateQueries({ queryKey: ['handoverLines', orderId] });
      qc.invalidateQueries({ queryKey: ['queueSummary'] });
      Alert.alert(
        'Handed over',
        `${res.handover_code} — ${Number(res.returned_quantity).toLocaleString()} returned to stock.`
      );
      navigation.goBack();
    },
    onError: (e) => Alert.alert('Could not hand over', describeDbError(e, 'Handover')),
  });

  const problem = useMemo(() => {
    for (const l of lines) {
      const e = entries[l.inventory_item_id];
      if (!e || e.onMachine) continue;
      if (e.leftover.trim() === '') return `Enter what is left of ${l.color_code}.`;
      const v = Number(e.leftover);
      if (Number.isNaN(v) || v < 0) return `${l.color_code} needs a number that is not negative.`;
      // Caught here as well as in the database so the user sees it against the
      // line they typed, not as a failed save after filling in the whole form.
      if (v > Number(l.issued_quantity)) {
        return `More ${l.color_code} came back than was issued.`;
      }
    }
    return null;
  }, [lines, entries]);

  if (q.isLoading) return <Screen><Loading label="Loading what was issued" /></Screen>;

  if (lines.length === 0) {
    return (
      <Screen>
        <EmptyState
          icon="cube-outline"
          title="Nothing was issued"
          message="No material was issued for this order, so there is nothing to hand back."
        />
      </Screen>
    );
  }

  const returning = lines.filter((l) => !entries[l.inventory_item_id]?.onMachine);
  const mounted = lines.filter((l) => entries[l.inventory_item_id]?.onMachine);

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          {orderCode ? `${orderCode} — ` : ''}say what is left of each item. Anything you enter goes
          back into store stock.
        </Text>

        {returning.length > 0 ? <Text style={styles.section}>Coming back</Text> : null}
        {returning.map((l) => (
          <LineCard
            key={l.inventory_item_id}
            line={l}
            entry={entries[l.inventory_item_id]}
            onChange={(e) =>
              setEntries((prev) => ({ ...prev, [l.inventory_item_id]: e }))
            }
          />
        ))}

        {mounted.length > 0 ? (
          <>
            <Text style={styles.section}>Still on the machine</Text>
            <Text style={styles.hint}>
              Recorded as mounted and not returned — these stay off the stock count.
            </Text>
            {mounted.map((l) => (
              <LineCard
                key={l.inventory_item_id}
                line={l}
                entry={entries[l.inventory_item_id]}
                onChange={(e) =>
                  setEntries((prev) => ({ ...prev, [l.inventory_item_id]: e }))
                }
              />
            ))}
          </>
        ) : null}

        <Text style={styles.section}>Note</Text>
        <TextInput
          style={[styles.input, { minHeight: 72 }]}
          value={note}
          onChangeText={setNote}
          multiline
          placeholder="Anything the store should know"
          placeholderTextColor={colors.inkSubtle}
        />

        {problem ? <Text style={styles.problem}>{problem}</Text> : null}

        <AppButton
          title="Hand over to the store"
          onPress={() => submit.mutate()}
          disabled={!!problem || submit.isPending}
          loading={submit.isPending}
          style={{ marginTop: spacing.md }}
        />
      </ScrollView>
    </Screen>
  );
}

function LineCard({
  line,
  entry,
  onChange,
}: {
  line: HandoverLine;
  entry: Entry | undefined;
  onChange: (e: Entry) => void;
}) {
  const e = entry ?? { leftover: '', onMachine: false };
  const used =
    !e.onMachine && e.leftover !== '' && !Number.isNaN(Number(e.leftover))
      ? Number(line.issued_quantity) - Number(e.leftover)
      : null;

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={styles.code}>{line.color_code}</Text>
          <Text style={styles.sub}>
            {ITEM_TYPE_LABEL[line.item_type]}
            {line.color_name ? ` · ${line.color_name}` : ''}
            {` · ${Number(line.issued_quantity).toLocaleString()} ${line.unit} issued`}
          </Text>
        </View>
      </View>

      <Pressable
        onPress={() => onChange({ ...e, onMachine: !e.onMachine, leftover: '' })}
        style={styles.toggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: e.onMachine }}
      >
        <Ionicons
          name={e.onMachine ? 'checkbox' : 'square-outline'}
          size={20}
          color={e.onMachine ? colors.primary : colors.slate}
        />
        <Text style={styles.toggleText}>Still on the machine</Text>
      </Pressable>

      {!e.onMachine ? (
        <View style={styles.leftoverRow}>
          <Text style={styles.leftoverLabel}>Left over</Text>
          <TextInput
            style={styles.qtyInput}
            value={e.leftover}
            onChangeText={(v) => onChange({ ...e, leftover: v })}
            keyboardType="decimal-pad"
            placeholder="0.0"
            placeholderTextColor={colors.inkSubtle}
            accessibilityLabel={`Leftover ${line.color_code}`}
          />
          <Text style={styles.unit}>{line.unit}</Text>
        </View>
      ) : null}

      {used != null ? (
        <Text style={styles.used}>
          {used.toLocaleString()} {line.unit} used on this order
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  intro: { fontSize: fontSize.secondary, color: colors.slate },
  section: {
    marginTop: spacing.md,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  hint: { fontSize: fontSize.caption, color: colors.inkSubtle },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center' },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  sub: { fontSize: fontSize.caption, color: colors.slate },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  toggleText: { fontSize: fontSize.secondary, color: colors.ink },
  leftoverRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  leftoverLabel: { flex: 1, fontSize: fontSize.secondary, color: colors.slate },
  qtyInput: {
    width: 96,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    textAlign: 'right',
  },
  unit: { width: 44, fontSize: fontSize.secondary, color: colors.slate },
  used: { fontSize: fontSize.caption, color: colors.primary },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSize.body,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  problem: { fontSize: fontSize.secondary, color: colors.alert },
});
