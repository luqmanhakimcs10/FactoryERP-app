/**
 * The app's standard queue/list row: a white rounded card on the soft canvas,
 * primary identifier + secondary line, status pill on the right, chevron last.
 *
 * This is the shape every queue screen uses (PO Queue, Handoff Queue, GRN
 * Queue), so it lives in components/lists and takes a status pill.
 *
 * The pill sits on the RIGHT rather than leading the row: the identifier is
 * what you scan a queue by, so it owns the left edge.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusPill } from '../ui/StatusPill';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  tracking,
} from '../../constants/theme';

interface Props {
  title: string;
  subtitle?: string;
  /** Additional detail line below subtitle (smaller, secondary colour). */
  caption?: string;
  /** Status pill text. Always a label — never colour alone (quality floor). */
  pillLabel?: string;
  pillColor?: string;
  /** Custom node rendered between body and chevron (e.g. a StatusPill). */
  rightNode?: React.ReactNode;
  /** Render the title in monospace — for codes and reference numbers. */
  monoTitle?: boolean;
  onPress?: () => void;
}

export function ListRow({
  title,
  subtitle,
  caption,
  pillLabel,
  pillColor = colors.inkMuted,
  rightNode,
  monoTitle,
  onPress,
}: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.body}>
        <Text
          style={[styles.title, monoTitle && { fontFamily: fontFamily.monoSemibold }]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {caption ? (
          <Text style={styles.caption} numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
      </View>

      {pillLabel ? <StatusPill label={pillLabel} color={pillColor} /> : null}

      {rightNode ? <View style={styles.rightNode}>{rightNode}</View> : null}

      <View style={styles.chev}>
        <Ionicons name="chevron-forward" size={16} color={colors.inkSubtle} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chev: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
  },
  pressed: { opacity: 0.75 },
  body: { flex: 1, minWidth: 0 },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
    letterSpacing: tracking.tight,
  },
  subtitle: {
    fontFamily: fontFamily.sans,
    marginTop: 2,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
  },
  caption: {
    fontFamily: fontFamily.sans,
    marginTop: 1,
    fontSize: fontSize.caption,
    color: colors.inkSubtle,
  },
  rightNode: { marginRight: spacing.xs },
});
