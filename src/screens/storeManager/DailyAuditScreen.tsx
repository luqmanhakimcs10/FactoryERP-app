/**
 * Today's audit — walk every inventory item, mark Correct or Incorrect.
 *
 * One item at a time rather than a table of editable boxes. The person doing
 * this is standing at a shelf with a phone in one hand; a grid of thirty inputs
 * invites the scroll-and-tap-the-wrong-row mistake that the audit exists to
 * catch. Correct is one tap, which is the answer most of the time.
 *
 * Nothing is written until the walk is finished and submitted, so the whole
 * count lands in one transaction. A half-recorded audit that moved some balances
 * and not others would be worse than no audit at all.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { EmptyState, Loading } from '../../components/ui/States';
import { describeDbError } from '../../utils/errors';
import {
  getAuditWalkItems,
  submitDailyAudit,
  ITEM_TYPE_LABEL,
  type AuditWalkItem,
} from '../../api/endpoints/storeManager';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

type Mark = { correct: boolean; actual: string } | undefined;

export function DailyAuditScreen() {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();
  const [idx, setIdx] = useState(0);
  const [marks, setMarks] = useState<Record<string, Mark>>({});

  const walk = useQuery({ queryKey: ['auditWalk'], queryFn: getAuditWalkItems });
  const items = walk.data ?? [];
  const item: AuditWalkItem | undefined = items[idx];

  const done = useMemo(
    () => items.filter((i) => marks[i.inventory_item_id] !== undefined).length,
    [items, marks]
  );

  const submit = useMutation({
    mutationFn: () =>
      submitDailyAudit(
        items.map((i) => {
          const m = marks[i.inventory_item_id]!;
          return m.correct
            ? { inventory_item_id: i.inventory_item_id, correct: true }
            : {
                inventory_item_id: i.inventory_item_id,
                correct: false,
                actual_quantity: Number(m.actual),
              };
        })
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['auditToday'] });
      qc.invalidateQueries({ queryKey: ['auditHistory'] });
      qc.invalidateQueries({ queryKey: ['inventoryItems'] });
      qc.invalidateQueries({ queryKey: ['threadStock'] });
      Alert.alert(
        'Audit recorded',
        `${res.items} item${res.items === 1 ? '' : 's'} counted, ${res.corrected} corrected.`
      );
      navigation.goBack();
    },
    onError: (e) => Alert.alert('Could not save the audit', describeDbError(e, 'Audit')),
  });

  if (walk.isLoading) return <Screen><Loading label="Loading items" /></Screen>;

  if (items.length === 0) {
    return (
      <Screen>
        <EmptyState
          icon="cube-outline"
          title="Nothing to count"
          message="Add some stock first and it will appear in the daily audit."
        />
      </Screen>
    );
  }

  const allMarked = done === items.length;
  const mark = item ? marks[item.inventory_item_id] : undefined;

  const setMark = (m: Mark) => {
    if (!item) return;
    setMarks((prev) => ({ ...prev, [item.inventory_item_id]: m }));
  };

  const advance = () => setIdx((i) => Math.min(i + 1, items.length - 1));

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.progressRow}>
          <Text style={styles.progressText}>
            Item {idx + 1} of {items.length}
          </Text>
          <Text style={styles.progressText}>{done} marked</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(done / items.length) * 100}%` }]} />
        </View>

        {item ? (
          <View style={styles.card}>
            <Text style={styles.type}>
              {ITEM_TYPE_LABEL[item.item_type]}
              {item.size_mm ? ` · ${item.size_mm} mm` : ''}
              {item.sequin_type ? ` · ${item.sequin_type}` : ''}
            </Text>
            <Text style={styles.code}>{item.color_code}</Text>
            {item.color_name ? <Text style={styles.name}>{item.color_name}</Text> : null}

            <Text style={styles.expectedLabel}>The system says</Text>
            <Text style={styles.expected}>
              {Number(item.expected_quantity).toLocaleString()} {item.unit}
            </Text>

            <View style={styles.choices}>
              <Pressable
                onPress={() => {
                  setMark({ correct: true, actual: '' });
                  advance();
                }}
                style={[styles.choice, mark?.correct === true && styles.choiceOnOk]}
                accessibilityRole="button"
                accessibilityState={{ selected: mark?.correct === true }}
              >
                <Ionicons
                  name="checkmark-circle"
                  size={20}
                  color={mark?.correct === true ? colors.white : colors.primary}
                />
                <Text style={[styles.choiceText, mark?.correct === true && styles.choiceTextOn]}>
                  Correct
                </Text>
              </Pressable>

              <Pressable
                onPress={() => setMark({ correct: false, actual: mark?.actual ?? '' })}
                style={[styles.choice, mark?.correct === false && styles.choiceOnBad]}
                accessibilityRole="button"
                accessibilityState={{ selected: mark?.correct === false }}
              >
                <Ionicons
                  name="alert-circle"
                  size={20}
                  color={mark?.correct === false ? colors.white : colors.accent}
                />
                <Text style={[styles.choiceText, mark?.correct === false && styles.choiceTextOn]}>
                  Incorrect
                </Text>
              </Pressable>
            </View>

            {mark?.correct === false ? (
              <View style={styles.actualBox}>
                <Text style={styles.expectedLabel}>What did you actually count?</Text>
                <TextInput
                  style={styles.input}
                  value={mark.actual}
                  onChangeText={(v) => setMark({ correct: false, actual: v })}
                  keyboardType="decimal-pad"
                  placeholder={`Amount in ${item.unit}`}
                  placeholderTextColor={colors.inkSubtle}
                  autoFocus
                />
                {mark.actual !== '' && !Number.isNaN(Number(mark.actual)) ? (
                  <Text style={styles.variance}>
                    {Number(mark.actual) === Number(item.expected_quantity)
                      ? 'That matches the system — mark it Correct instead.'
                      : `${
                          Number(mark.actual) > Number(item.expected_quantity) ? '+' : ''
                        }${(Number(mark.actual) - Number(item.expected_quantity)).toLocaleString()} ${
                          item.unit
                        } will be recorded as a variance.`}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.nav}>
          <AppButton
            title="Back"
            variant="secondary"
            size="sm"
            onPress={() => setIdx((i) => Math.max(i - 1, 0))}
            disabled={idx === 0}
          />
          <AppButton
            title="Next"
            variant="secondary"
            size="sm"
            onPress={advance}
            disabled={idx >= items.length - 1}
          />
        </View>

        <AppButton
          title={allMarked ? 'Submit today’s audit' : `Mark all ${items.length} items first`}
          onPress={() => submit.mutate()}
          disabled={!allMarked || submit.isPending}
          loading={submit.isPending}
        />
        <Text style={styles.footNote}>
          Nothing is saved until you submit — the whole count goes in at once.
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressText: { fontSize: fontSize.caption, color: colors.slate },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: { height: 6, backgroundColor: colors.primary },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  type: {
    fontSize: fontSize.caption,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.title,
    color: colors.ink,
    fontWeight: fontWeight.semibold,
  },
  name: { fontSize: fontSize.secondary, color: colors.slate },
  expectedLabel: { marginTop: spacing.md, fontSize: fontSize.caption, color: colors.slate },
  expected: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.title,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  choices: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  choice: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  choiceOnOk: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceOnBad: { backgroundColor: colors.accent, borderColor: colors.accent },
  choiceText: { fontSize: fontSize.body, color: colors.ink, fontWeight: fontWeight.medium },
  choiceTextOn: { color: colors.white },
  actualBox: { marginTop: spacing.md, gap: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  variance: { fontSize: fontSize.caption, color: colors.accent },
  nav: { flexDirection: 'row', gap: spacing.md, justifyContent: 'space-between' },
  footNote: { fontSize: fontSize.caption, color: colors.inkSubtle, textAlign: 'center' },
});
