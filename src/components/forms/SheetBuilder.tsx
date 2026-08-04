/**
 * Sheet builder — the repeatable sub-card form pattern.
 *
 * An order has any number of sheets; each sheet carries its own colour
 * assignment, repeat count, thread colour codes and stitch count. This is what
 * produces the order → sheets → repeats hierarchy: the repeats_count entered here
 * is expanded into individual `repeats` rows at QA coding.
 *
 * Built as a shared component because the same bordered "sub-card + big Add"
 * pattern is reused for job card lines, PO items and damage entry.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TextField } from './TextField';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';
import type { SheetInput } from '../../models/orderTypes';

/** Form-local draft: numbers are strings while being typed. */
export interface SheetDraft {
  color_assignment: string;
  repeats_count: string;
  thread_color_codes: string;
  stitch_count: string;
}

export const EMPTY_SHEET: SheetDraft = {
  color_assignment: '',
  repeats_count: '',
  thread_color_codes: '',
  stitch_count: '',
};

interface Props {
  sheets: SheetDraft[];
  onChange: (sheets: SheetDraft[]) => void;
  errors?: Record<number, Partial<Record<keyof SheetDraft, string>>>;
}

export function SheetBuilder({ sheets, onChange, errors }: Props) {
  function update(i: number, key: keyof SheetDraft, value: string) {
    onChange(sheets.map((s, idx) => (idx === i ? { ...s, [key]: value } : s)));
  }
  function addSheet() {
    onChange([...sheets, { ...EMPTY_SHEET }]);
  }
  function removeSheet(i: number) {
    onChange(sheets.filter((_, idx) => idx !== i));
  }

  return (
    <View>
      {sheets.map((sheet, i) => {
        const err = errors?.[i] ?? {};
        const repeats = parseInt(sheet.repeats_count, 10);
        const stitches = parseInt(sheet.stitch_count, 10);
        const totalStitches =
          Number.isFinite(repeats) && Number.isFinite(stitches) ? repeats * stitches : null;

        return (
          <View key={i} style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Sheet {i + 1}</Text>
              {sheets.length > 1 ? (
                <Pressable
                  onPress={() => removeSheet(i)}
                  accessibilityLabel={`Remove sheet ${i + 1}`}
                  accessibilityRole="button"
                  hitSlop={8}
                  style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.alert} />
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              ) : null}
            </View>

            <TextField
              label="Colour assignment"
              value={sheet.color_assignment}
              onChangeText={(v) => update(i, 'color_assignment', v)}
              placeholder="e.g. Red base"
              required
              error={err.color_assignment}
            />

            <TextField
              label="Repeats on this sheet"
              value={sheet.repeats_count}
              onChangeText={(v) => update(i, 'repeats_count', v)}
              placeholder="e.g. 12"
              required
              numeric
              mono
              error={err.repeats_count}
            />

            <TextField
              label="Thread colour codes"
              value={sheet.thread_color_codes}
              onChangeText={(v) => update(i, 'thread_color_codes', v)}
              placeholder="RED-01, GLD-02"
              required
              mono
              error={err.thread_color_codes}
            />
            <Text style={styles.fieldHint}>
              Comma-separated. Each becomes a needle line on the job card.
            </Text>

            <TextField
              label="Stitch count per repeat"
              value={sheet.stitch_count}
              onChangeText={(v) => update(i, 'stitch_count', v)}
              placeholder="e.g. 12000"
              required
              numeric
              mono
              error={err.stitch_count}
            />

            {totalStitches !== null && totalStitches > 0 ? (
              <Text style={styles.calc}>
                {repeats} repeats ×{' '}
                <Text style={styles.mono}>{stitches.toLocaleString()}</Text> stitches ={' '}
                <Text style={styles.mono}>{totalStitches.toLocaleString()}</Text> total
              </Text>
            ) : null}
          </View>
        );
      })}

      {/* Unmistakable add affordance, per the design system. */}
      <Pressable
        onPress={addSheet}
        accessibilityRole="button"
        style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
      >
        <Ionicons name="add" size={22} color={colors.indigoDeep} />
        <Text style={styles.addText}>Add sheet</Text>
      </Pressable>
    </View>
  );
}

/** Turn drafts into RPC input, dropping blank colour codes. */
export function toSheetInputs(drafts: SheetDraft[]): SheetInput[] {
  return drafts.map((d) => ({
    color_assignment: d.color_assignment.trim(),
    repeats_count: parseInt(d.repeats_count, 10),
    stitch_count: parseInt(d.stitch_count, 10),
    thread_color_codes: d.thread_color_codes
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  }));
}

/** Per-sheet validation. Returns {} when the whole set is valid. */
export function validateSheets(
  drafts: SheetDraft[]
): Record<number, Partial<Record<keyof SheetDraft, string>>> {
  const out: Record<number, Partial<Record<keyof SheetDraft, string>>> = {};

  drafts.forEach((d, i) => {
    const e: Partial<Record<keyof SheetDraft, string>> = {};

    if (!d.color_assignment.trim()) e.color_assignment = 'Colour assignment is required.';

    const repeats = parseInt(d.repeats_count, 10);
    if (!Number.isFinite(repeats) || repeats < 1) e.repeats_count = 'Enter at least 1 repeat.';

    const stitches = parseInt(d.stitch_count, 10);
    if (!Number.isFinite(stitches) || stitches < 0) e.stitch_count = 'Enter a stitch count.';

    const codes = d.thread_color_codes
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (!codes.length) e.thread_color_codes = 'At least one thread colour code is required.';

    if (Object.keys(e).length) out[i] = e;
  });

  return out;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  cardTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  remove: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  removeText: { color: colors.alert, fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  fieldHint: {
    marginTop: -spacing.md,
    marginBottom: spacing.lg,
    fontSize: fontSize.caption,
    color: colors.slate,
  },
  calc: {
    marginTop: -spacing.sm,
    fontSize: fontSize.secondary,
    color: colors.slate,
  },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
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
  addText: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  pressed: { opacity: 0.7 },
});
