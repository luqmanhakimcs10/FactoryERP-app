/**
 * The app's button.
 *
 * Props are unchanged from before — every existing call site keeps working —
 * this is purely a visual upgrade: real elevation on raised variants, a softer
 * radius, a proper pressed state that sinks rather than just fading, and a
 * secondary that reads as a real control instead of an outline.
 */
import React from 'react';
import {
  Pressable,
  Text,
  StyleSheet,
  ActivityIndicator,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  radius,
  spacing,
  fontSize,
  fontWeight,
  fontFamily,
  elevation,
  tracking,
} from '../../constants/theme';

interface Props {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'brass' | 'alert' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  /** Optional leading icon — purely decorative, never the only label. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** `sm` for inline/table actions; default is the full-width control size. */
  size?: 'sm' | 'md';
}

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  style,
  icon,
  size = 'md',
}: Props) {
  const isDisabled = disabled || loading;
  const filled = variant === 'primary' || variant === 'brass' || variant === 'alert';

  const fill =
    variant === 'brass' ? colors.accent
    : variant === 'alert' ? colors.accent
    : variant === 'primary' ? colors.primary
    : 'transparent';

  // Both filled hues (teal, coral) are dark enough to carry white text.
  const label =
    filled ? colors.white
    : variant === 'ghost' ? colors.inkMuted
    : colors.primary;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [
        styles.base,
        size === 'sm' && styles.sm,
        { backgroundColor: fill },
        variant === 'secondary' && styles.secondary,
        variant === 'ghost' && styles.ghost,
        // Raised only while it can actually be pressed.
        filled && !isDisabled && elevation.md,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={label} size="small" />
      ) : (
        <View style={styles.row}>
          {icon ? (
            <Ionicons name={icon} size={size === 'sm' ? 15 : 17} color={label} />
          ) : null}
          <Text
            style={[
              styles.label,
              size === 'sm' && styles.labelSm,
              { color: label },
            ]}
            numberOfLines={1}
          >
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52, // generous on a factory-floor phone
    borderRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sm: { minHeight: 38, paddingHorizontal: spacing.lg, borderRadius: radius.md },
  secondary: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  ghost: { backgroundColor: 'transparent' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    letterSpacing: tracking.normal,
  },
  labelSm: { fontSize: fontSize.secondary },
  // Sinks slightly instead of only dimming — reads as a real press.
  pressed: { opacity: 0.92, transform: [{ translateY: 1 }] },
  disabled: { opacity: 0.45 },
});
