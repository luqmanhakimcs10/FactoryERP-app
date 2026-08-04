/**
 * The "needs your attention" banner — a solid coral card with a bold title, a
 * smaller subtitle beneath, and a trailing arrow.
 *
 * ONE component for every role's equivalent notice (pending approvals, low
 * stock, SLA breaches, material ready, ...). Callers pass their own existing
 * wording; this owns only the shape. Deliberately no default copy — a banner
 * with invented text would be worse than no banner.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  elevation,
} from '../../constants/theme';

interface Props {
  /** Short bold line — e.g. "3 approvals waiting". */
  title: string;
  /** Smaller supporting line — e.g. "Expenses and damage deductions". */
  subtitle?: string;
  onPress?: () => void;
  /**
   * `neutral` renders the same shape in teal, for a notice that is informative
   * rather than urgent. Coral is the default because this is an alert slot.
   */
  tone?: 'attention' | 'neutral';
  /** Layout only (margins) — the banner owns its own colour and padding. */
  style?: ViewStyle;
}

export function ActionBanner({ title, subtitle, onPress, tone = 'attention', style }: Props) {
  const fill = tone === 'neutral' ? colors.primary : colors.accent;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      style={({ pressed }) => [
        styles.root,
        { backgroundColor: fill },
        onPress ? elevation.sm : null,
        pressed && styles.pressed,
        style,
      ]}
    >
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {onPress ? (
        <Ionicons name="arrow-forward" size={22} color={colors.white} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
  },
  pressed: { opacity: 0.88 },
  text: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: fontFamily.displayBold,
    color: colors.white,
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
  },
  subtitle: {
    fontFamily: fontFamily.sans,
    marginTop: 2,
    color: 'rgba(255,255,255,0.88)',
    fontSize: fontSize.secondary,
  },
});

export default ActionBanner;
