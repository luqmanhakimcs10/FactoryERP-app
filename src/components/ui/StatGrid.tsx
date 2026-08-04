/**
 * Key-metrics grid — the 2-column block of white cards a dashboard uses for its
 * summary numbers. Each card: a tinted icon well, a large monospace number, a
 * muted label beneath.
 *
 * The number is mono because it is a figure to be read exactly, which is the
 * same reason order codes are mono. `value` stays a string so the caller keeps
 * control of its own formatting ("2.4L", "—", "12") — this component never
 * invents or rounds a number.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export interface StatCardProps {
  /** Big figure. Pass '—' for "not loaded yet" — never a misleading 0. */
  value: string;
  /** Muted line beneath the figure — e.g. "Active orders". */
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  /**
   * `attention` tints the icon well coral, for a metric that means work is
   * waiting. Default teal is the routine/positive treatment.
   */
  tone?: 'neutral' | 'attention';
  onPress?: () => void;
}

export function StatCard({ value, label, icon, tone = 'neutral', onPress }: StatCardProps) {
  const attention = tone === 'attention';
  const wellBg = attention ? colors.tintCoral : colors.tintTeal;
  const wellInk = attention ? colors.accent : colors.primary;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${value} ${label}`}
      style={({ pressed }) => [styles.card, pressed && onPress ? styles.pressed : null]}
    >
      <View style={[styles.well, { backgroundColor: wellBg }]}>
        <Ionicons name={icon} size={20} color={wellInk} />
      </View>
      <Text style={styles.value} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Two-column wrapper. Cards flow in pairs and wrap. */
export function StatGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  card: {
    // Two per row, accounting for the gap between them.
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 140,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  pressed: { opacity: 0.75 },
  well: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  value: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  label: {
    fontFamily: fontFamily.sans,
    marginTop: 2,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
  },
});

export default StatGrid;
