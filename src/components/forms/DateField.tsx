/**
 * Calendar date picker.
 *
 * Built rather than pulled in: `@react-native-community/datetimepicker` is not
 * in this project's dependency set, and on web it degrades to a native input
 * that ignores every token in the design system. A month grid is ~150 lines,
 * behaves identically on iOS, Android and web, and keeps the same chip/press
 * language as SelectField beside it on the same form.
 *
 * VALUE FORMAT is `YYYY-MM-DD` — a plain calendar date with no time and no zone.
 * That matters: a billing date is a day on a wall calendar, and round-tripping
 * one through `Date.toISOString()` shifts it backwards for anyone east of UTC.
 * Nothing here ever converts through UTC.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

interface Props {
  label: string;
  /** `YYYY-MM-DD`, or null for "not set". */
  value: string | null;
  onChange: (v: string | null) => void;
  required?: boolean;
  error?: string;
  editable?: boolean;
  /** Text shown when there is no date yet. */
  placeholder?: string;
  /** Offer a "Clear" control inside the calendar. */
  allowClear?: boolean;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY-MM-DD` for a local-time Date. Never goes through UTC. */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse `YYYY-MM-DD` as a LOCAL date. `new Date(iso)` would parse it as UTC. */
function parseIso(iso: string | null): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDisplayDate(iso: string | null): string {
  const d = parseIso(iso);
  if (!d) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Monday-first grid of the given month, padded with nulls to whole weeks. */
function monthGrid(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1);
  // getDay(): 0 = Sunday. Shift so Monday is 0.
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function DateField({
  label,
  value,
  onChange,
  required,
  error,
  editable = true,
  placeholder = 'Select a date',
  allowClear = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const selected = parseIso(value);
  // The month the grid is showing. Opens on the selected date's month, or this
  // month when nothing is set yet.
  const [cursor, setCursor] = useState(() => selected ?? new Date());

  const cells = useMemo(
    () => monthGrid(cursor.getFullYear(), cursor.getMonth()),
    [cursor]
  );
  const todayIso = toIso(new Date());

  function openPicker() {
    if (!editable) return;
    setCursor(parseIso(value) ?? new Date());
    setOpen(true);
  }

  function shiftMonth(delta: number) {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.req}> *</Text> : null}
      </Text>

      <Pressable
        onPress={openPicker}
        disabled={!editable}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? formatDisplayDate(value) : 'not set'}`}
        style={({ pressed }) => [
          styles.input,
          pressed && editable && styles.inputPressed,
          !!error && styles.inputError,
          !editable && styles.inputDisabled,
        ]}
      >
        <Text style={[styles.inputText, !value && styles.inputPlaceholder]}>
          {value ? formatDisplayDate(value) : placeholder}
        </Text>
        <Ionicons name="calendar-outline" size={18} color={colors.inkMuted} />
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.scrim}
          accessibilityRole="button"
          accessibilityLabel="Close calendar"
          onPress={() => setOpen(false)}
        >
          <Pressable style={styles.calendar} onPress={() => {}}>
            <View style={styles.calHeader}>
              <Pressable
                onPress={() => shiftMonth(-1)}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                hitSlop={8}
                style={styles.navBtn}
              >
                <Ionicons name="chevron-back" size={18} color={colors.primary} />
              </Pressable>
              <Text style={styles.calTitle}>
                {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
              </Text>
              <Pressable
                onPress={() => shiftMonth(1)}
                accessibilityRole="button"
                accessibilityLabel="Next month"
                hitSlop={8}
                style={styles.navBtn}
              >
                <Ionicons name="chevron-forward" size={18} color={colors.primary} />
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {WEEKDAYS.map((w) => (
                <Text key={w} style={styles.weekday}>
                  {w}
                </Text>
              ))}
            </View>

            <View style={styles.grid}>
              {cells.map((day, i) => {
                if (day === null) return <View key={`b${i}`} style={styles.cell} />;
                const iso = toIso(new Date(cursor.getFullYear(), cursor.getMonth(), day));
                const isSelected = iso === value;
                const isToday = iso === todayIso;
                return (
                  <Pressable
                    key={iso}
                    onPress={() => {
                      onChange(iso);
                      setOpen(false);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    style={({ pressed }) => [
                      styles.cell,
                      styles.dayCell,
                      isToday && !isSelected && styles.dayToday,
                      isSelected && styles.daySelected,
                      pressed && !isSelected && styles.dayPressed,
                    ]}
                  >
                    <Text style={[styles.dayText, isSelected && styles.dayTextSelected]}>
                      {day}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.calFooter}>
              {allowClear ? (
                <Pressable
                  onPress={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  style={styles.footerBtn}
                >
                  <Text style={styles.footerBtnText}>Clear</Text>
                </Pressable>
              ) : (
                <View />
              )}
              <Pressable
                onPress={() => {
                  onChange(todayIso);
                  setOpen(false);
                }}
                accessibilityRole="button"
                style={styles.footerBtn}
              >
                <Text style={styles.footerBtnText}>Today</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  req: { color: colors.accent },
  input: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  inputPressed: { backgroundColor: colors.pressed },
  inputDisabled: { backgroundColor: colors.bg },
  inputError: { borderColor: colors.alert },
  inputText: { fontSize: fontSize.body, color: colors.ink },
  inputPlaceholder: { color: colors.inkSubtle },
  error: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.alert },

  scrim: {
    flex: 1,
    backgroundColor: 'rgba(27, 46, 45, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  calendar: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  calHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
  },
  navBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  calTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  weekRow: { flexDirection: 'row' },
  weekday: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.caption,
    color: colors.inkMuted,
    paddingVertical: spacing.xs,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  dayCell: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  dayToday: { borderWidth: 1, borderColor: colors.primary },
  daySelected: { backgroundColor: colors.primary },
  dayPressed: { backgroundColor: colors.pressed },
  dayText: { fontSize: fontSize.secondary, color: colors.ink },
  dayTextSelected: { color: colors.white, fontWeight: fontWeight.semibold },
  calFooter: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerBtn: { minHeight: 40, justifyContent: 'center', paddingHorizontal: spacing.md },
  footerBtnText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.primary,
  },
});

export default DateField;
