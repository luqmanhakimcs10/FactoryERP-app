/**
 * Several-of-a-small-set, rendered as toggle chips.
 *
 * The same chip language as SelectField beside it on the same form, with two
 * differences that matter for accessibility: the role is `checkbox` rather than
 * `radio` (choices are not exclusive), and a selection summary is rendered
 * under the chips so the current answer is readable as text and not only as a
 * pattern of filled shapes.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';
import type { Option } from './SelectField';

interface Props {
  label: string;
  value: string[];
  options: Option[];
  onChange: (v: string[]) => void;
  required?: boolean;
  error?: string;
  /** Text shown when nothing is selected. */
  emptyLabel?: string;
}

export function MultiSelectField({
  label,
  value,
  options,
  onChange,
  required,
  error,
  emptyLabel = 'None selected',
}: Props) {
  function toggle(key: string) {
    onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key]);
  }

  const summary = options
    .filter((o) => value.includes(o.value))
    .map((o) => o.label)
    .join(', ');

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.req}> *</Text> : null}
      </Text>

      <View style={styles.chips}>
        {options.map((o) => {
          const selected = value.includes(o.value);
          // react-native-web does not map accessibilityState.checked here, so
          // set aria-checked directly: selection must never be colour alone.
          const webAria = Platform.OS === 'web' ? ({ 'aria-checked': selected } as object) : null;
          return (
            <Pressable
              key={o.value}
              onPress={() => toggle(o.value)}
              {...webAria}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected }}
              style={({ pressed }) => [
                styles.chip,
                selected && styles.chipSelected,
                pressed && !selected && styles.chipPressed,
              ]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                {selected ? '✓ ' : ''}
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.summary}>{summary || emptyLabel}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipPressed: { backgroundColor: colors.pressed },
  chipText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    fontWeight: fontWeight.medium,
  },
  chipTextSelected: { color: colors.white, fontWeight: fontWeight.semibold },
  summary: { marginTop: spacing.sm, fontSize: fontSize.caption, color: colors.inkMuted },
  error: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.alert },
});

export default MultiSelectField;
