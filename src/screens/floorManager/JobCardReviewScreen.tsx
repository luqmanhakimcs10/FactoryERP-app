/**
 * Floor Manager: Job Card Review (Stage 3).
 *
 * The distinct review step the Builder hands off to — every needle's assigned
 * colour is editable here (the Builder only ever shows a read-only preview), a
 * line can be dropped, and a needle can be added one at a time.
 *
 * Needle numbers are NOT chosen here. They are positional and assigned
 * server-side (0053): "+ Add needle" appends the next one, and deleting a line
 * renumbers the rest so the mapping never reads "Needle 1, Needle 3". Showing a
 * 1..6 picker per line, as this screen used to, offered a choice that was
 * already implied by position and repeated a six-button bank down the page.
 *
 * "Submit job card" is a navigation gate into the existing job card detail
 * screen (download/share/vendor confirmation/material) — it doesn't introduce a
 * new DB transition of its own.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { Ionicons } from '@expo/vector-icons';
import {
  getOrder,
  getJobCard,
  updateJobCardLine,
  deleteJobCardLine,
  addJobCardLine,
} from '../../api/endpoints/orders';
import { describeDbError } from '../../utils/errors';
import { useNextStep, NEXT_STEP } from '../../components/ui/NextStepToast';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

/** The most needles on any machine in the factory — matches the DB cap (0037/0053). */
const MAX_NEEDLES = 6;

export function JobCardReviewScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const showNextStep = useNextStep();
  const orderId: string = route.params?.orderId;

  const [colorEdits, setColorEdits] = useState<Record<string, string>>({});
  const [newColor, setNewColor] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingLineId, setSavingLineId] = useState<string | null>(null);
  const [deletingLineId, setDeletingLineId] = useState<string | null>(null);

  const { data: order, isLoading } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId),
  });
  const { data: jobCard } = useQuery({
    queryKey: ['jobCard', orderId],
    queryFn: () => getJobCard(orderId),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['jobCard', orderId] });
  }

  const updateLineMutation = useMutation({
    mutationFn: ({ lineId, needle, color }: { lineId: string; needle: number; color: string }) =>
      updateJobCardLine(jobCard!.card!.id, lineId, needle, color),
    onMutate: ({ lineId }) => setSavingLineId(lineId),
    onSuccess: (_data, { lineId }) => {
      setColorEdits((prev) => {
        const next = { ...prev };
        delete next[lineId];
        return next;
      });
      invalidate();
    },
    onError: (e: unknown) => setError(describeDbError(e, 'Job card')),
    onSettled: () => setSavingLineId(null),
  });

  const deleteLineMutation = useMutation({
    mutationFn: (lineId: string) => deleteJobCardLine(jobCard!.card!.id, lineId),
    onMutate: (lineId) => setDeletingLineId(lineId),
    onSuccess: () => {
      // Deleting renumbers the remaining lines server-side, so any unsaved
      // colour edits are now keyed to needles that have shifted. Drop them
      // rather than let a stale edit save against the wrong needle.
      setColorEdits({});
      invalidate();
    },
    onError: (e: unknown) => setError(describeDbError(e, 'Job card')),
    onSettled: () => setDeletingLineId(null),
  });

  const addLineMutation = useMutation({
    mutationFn: (color: string) => addJobCardLine(jobCard!.card!.id, color),
    onSuccess: () => {
      setNewColor('');
      setAdding(false);
      invalidate();
    },
    onError: (e: unknown) => setError(describeDbError(e, 'Job card')),
  });

  if (isLoading || !order || !jobCard) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const lines = (jobCard.lines ?? []).slice().sort((a, b) => a.needle_number - b.needle_number);
  const anyDirty = lines.some((l) => {
    const e = colorEdits[l.id];
    return e !== undefined && e !== l.thread_color_code;
  });
  const atCap = lines.length >= MAX_NEEDLES;
  const busy = updateLineMutation.isPending || deleteLineMutation.isPending || addLineMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>{order.vendors?.name}</Text>

        <Text style={styles.sectionTitle}>Needle & color lines</Text>
        <Text style={styles.help}>
          Correct each needle's thread colour against the physical machine setup, or drop a line
          entirely, before submitting. Needle numbers follow their order here and are capped at{' '}
          {MAX_NEEDLES}.
        </Text>

        {lines.map((l) => {
          const color = colorEdits[l.id] ?? l.thread_color_code;
          const dirty = color !== l.thread_color_code;
          return (
            <View key={l.id} style={styles.row}>
              <View style={styles.rowHead}>
                <View style={styles.needleBadge}>
                  <Text style={styles.needleBadgeText}>Needle {l.needle_number}</Text>
                </View>
                <Pressable
                  onPress={() => {
                    setError(null);
                    deleteLineMutation.mutate(l.id);
                  }}
                  disabled={lines.length <= 1 || busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete needle ${l.needle_number} line`}
                  hitSlop={8}
                  style={styles.deleteBtn}
                >
                  {deletingLineId === l.id ? (
                    <ActivityIndicator color={colors.alert} size="small" />
                  ) : (
                    <Ionicons
                      name="trash-outline"
                      size={20}
                      color={lines.length <= 1 ? colors.border : colors.alert}
                    />
                  )}
                </Pressable>
              </View>
              <TextField
                label="Thread colour"
                value={color}
                onChangeText={(v) => setColorEdits((prev) => ({ ...prev, [l.id]: v }))}
                mono
              />
              {dirty ? (
                <AppButton
                  title="Save"
                  variant="secondary"
                  loading={savingLineId === l.id}
                  disabled={busy && savingLineId !== l.id}
                  onPress={() => {
                    setError(null);
                    if (!color.trim()) {
                      setError('A thread colour is required.');
                      return;
                    }
                    updateLineMutation.mutate({
                      lineId: l.id,
                      needle: l.needle_number,
                      color: color.trim(),
                    });
                  }}
                  style={styles.saveBtn}
                />
              ) : null}
            </View>
          );
        })}

        {adding && !atCap ? (
          <View style={styles.row}>
            <View style={styles.rowHead}>
              <View style={styles.needleBadge}>
                <Text style={styles.needleBadgeText}>Needle {lines.length + 1}</Text>
              </View>
            </View>
            <TextField
              label="Thread colour"
              value={newColor}
              onChangeText={setNewColor}
              placeholder="e.g. RED-01"
              mono
            />
            <View style={styles.addActions}>
              <AppButton
                title="Cancel"
                variant="ghost"
                disabled={addLineMutation.isPending}
                onPress={() => {
                  setError(null);
                  setNewColor('');
                  setAdding(false);
                }}
                style={styles.saveBtn}
              />
              <AppButton
                title="Add"
                variant="secondary"
                loading={addLineMutation.isPending}
                disabled={addLineMutation.isPending}
                onPress={() => {
                  setError(null);
                  if (!newColor.trim()) {
                    setError('A thread colour is required.');
                    return;
                  }
                  addLineMutation.mutate(newColor.trim());
                }}
                style={styles.saveBtn}
              />
            </View>
          </View>
        ) : null}

        {atCap ? (
          <Text style={styles.help}>
            All {MAX_NEEDLES} needles are assigned — delete a line to free one up.
          </Text>
        ) : adding ? null : (
          <Pressable
            onPress={() => {
              setError(null);
              setAdding(true);
            }}
            disabled={busy}
            accessibilityRole="button"
            style={({ pressed }) => [styles.addNeedle, pressed && styles.pressed]}
          >
            <Text style={styles.addNeedleText}>+ Add needle</Text>
          </Pressable>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {anyDirty ? <Text style={styles.help}>Save your changes before submitting.</Text> : null}

        <AppButton
          title="Submit job card"
          onPress={() => {
            setError(null);
            if (anyDirty) {
              setError('Save your changes before submitting.');
              return;
            }
            // Fired here rather than at generateJobCard in the Builder: this is
            // the press that lands the user on the screen holding the next
            // action, so the guidance points at something they can see.
            showNextStep(NEXT_STEP.jobCardCreated);
            navigation.replace('JobCard', { orderId });
          }}
          disabled={busy}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { marginTop: spacing.xs, marginBottom: spacing.lg, fontSize: fontSize.body, color: colors.indigoDeep },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  help: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.md, lineHeight: 20 },
  row: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  needleBadge: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.border,
  },
  needleBadgeText: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.secondary,
    color: colors.indigoDeep,
    fontWeight: fontWeight.medium,
  },
  deleteBtn: { padding: spacing.xs },
  saveBtn: { marginTop: spacing.xs, minHeight: 40, paddingHorizontal: spacing.md, alignSelf: 'flex-start' },
  addActions: { flexDirection: 'row', gap: spacing.sm },
  addNeedle: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.indigo,
  },
  addNeedleText: { fontSize: fontSize.secondary, color: colors.indigo, fontWeight: fontWeight.medium },
  pressed: { opacity: 0.75 },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
});
