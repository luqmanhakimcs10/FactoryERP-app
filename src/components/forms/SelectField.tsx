/**
 * Select field rendered as inline chips rather than a native picker.
 *
 * Chosen deliberately: option sets here are small (4 stage types, 2 rate bases),
 * and floor-facing screens want a single visible tap, not a modal roll. A solid
 * teal chip marks the selected state per the design system. Also used for
 * `linked` fields once their options are loaded, and re-used later for
 * needle/colour selects.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export interface Option {
  value: string;
  label: string;
}

interface Props {
  label: string;
  value: string | null;
  options: Option[];
  onChange: (v: string | null) => void;
  required?: boolean;
  error?: string;
  loading?: boolean;
  /** Show a "none" chip that clears the value (used by optional linked fields). */
  allowClear?: boolean;
  clearLabel?: string;
  emptyHint?: string;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  required,
  error,
  loading,
  allowClear,
  clearLabel = 'None',
  emptyHint,
}: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.req}> *</Text> : null}
      </Text>

      {loading ? (
        <ActivityIndicator color={colors.indigo} style={{ alignSelf: 'flex-start' }} />
      ) : options.length === 0 ? (
        <Text style={styles.hint}>{emptyHint ?? 'No options available.'}</Text>
      ) : (
        <View style={styles.chips} accessibilityRole="radiogroup">
          {allowClear ? (
            <Chip
              label={clearLabel}
              selected={value === null || value === ''}
              onPress={() => onChange(null)}
            />
          ) : null}
          {options.map((o) => (
            <Chip
              key={o.value}
              label={o.label}
              selected={value === o.value}
              onPress={() => onChange(o.value)}
            />
          ))}
        </View>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  // react-native-web (this version) doesn't map accessibilityState.checked to
  // aria-checked, so set it directly on web. Without it, selection would be
  // conveyed by colour alone — which the quality floor forbids.
  const webAria = Platform.OS === 'web' ? ({ 'aria-checked': selected } as object) : null;

  return (
    <Pressable
      onPress={onPress}
      {...webAria}
      // Radio semantics, not button: the group is mutually exclusive.
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.chipPressed,
      ]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
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
  chipPressed: { opacity: 0.7 },
  chipText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    fontWeight: fontWeight.medium,
  },
  chipTextSelected: { color: colors.white, fontWeight: fontWeight.semibold },
  hint: { fontSize: fontSize.secondary, color: colors.inkMuted, fontStyle: 'italic' },
  error: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.accent },
});
