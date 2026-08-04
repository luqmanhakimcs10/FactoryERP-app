/**
 * Pill-segmented tab control.
 *
 * Replaces the underline tab bars each queue screen had rolled for itself. The
 * LABELS and their count suffixes are the caller's — this owns only the shape,
 * so migrating a screen never changes what its tabs are called or how many
 * there are.
 *
 * Scrolls horizontally: several screens have four or five tabs whose labels
 * carry counts ("Awaiting job card (12)"), which will not fit a phone width.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export interface SegmentedTab<K extends string = string> {
  key: K;
  label: string;
}

interface Props<K extends string = string> {
  tabs: ReadonlyArray<SegmentedTab<K>>;
  value: K;
  onChange: (key: K) => void;
}

export function SegmentedTabs<K extends string = string>({ tabs, value, onChange }: Props<K>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // Without this the ScrollView takes flex height from its column parent
      // and collapses the rail to nothing — the tabs vanish entirely.
      style={styles.rail}
      contentContainerStyle={styles.track}
      // The rail is a control strip, not content — it should not bounce.
      bounces={false}
    >
      {tabs.map((t) => {
        const selected = t.key === value;
        // react-native-web does not map accessibilityState.selected to
        // aria-selected here, so set it directly: without it, the active tab
        // would be conveyed by colour alone.
        const webAria = Platform.OS === 'web' ? ({ 'aria-selected': selected } as object) : null;

        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            {...webAria}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.tab,
              selected && styles.tabSelected,
              pressed && !selected && styles.tabPressed,
            ]}
          >
            <Text style={[styles.text, selected && styles.textSelected]} numberOfLines={1}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  rail: { flexGrow: 0, flexShrink: 0 },
  track: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  tab: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabPressed: { backgroundColor: colors.pressed },
  text: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
  },
  textSelected: { color: colors.white, fontWeight: fontWeight.semibold },
});

export default SegmentedTabs;
