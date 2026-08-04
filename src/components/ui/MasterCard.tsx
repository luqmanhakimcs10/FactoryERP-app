/**
 * The launcher card used by the role dashboards (Floor Manager, Accountant,
 * Order Taker, QA, Store Manager) and the Company Admin's Masters screen.
 *
 * Extracted so the launchers cannot drift: same icon well, same title /
 * subtitle / count layout. A new launcher gets the card by importing it, never
 * by copying the styles.
 *
 * TWO LAYOUTS, ONE CARD — and the distinction is the whole point:
 *
 *   layout="grid" (default)  A NAVIGATION MENU CARD. The top-level sections on
 *                            a role's dashboard that you tap to go elsewhere.
 *                            Squarish, two per row: icon badge and count on the
 *                            top line, title and subtitle beneath.
 *
 *   layout="row"             A full-width stacked row. For lists of RECORDS
 *                            inside a section, where scanning a single column
 *                            beats a grid.
 *
 * Grid is the default because every current caller is a dashboard menu, and the
 * bug this fixes was exactly that they all rendered as rows.
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

export interface MasterCardProps {
  label: string;
  subtitle: string;
  icon: string;
  /**
   * The card's accent. Kept as a colour (rather than a tone name) because every
   * existing call site passes one; `colors.accent` reads as "needs attention",
   * anything else as routine. Pass `tone` to override that reading.
   */
  accent: string;
  /** null renders an em dash — "not loaded yet", never a misleading 0. */
  count: number | null;
  tone?: 'neutral' | 'attention';
  /** See the header — 'grid' for dashboard menus, 'row' for record lists. */
  layout?: 'grid' | 'row';
  onPress: () => void;
}

export function MasterCard({
  label,
  subtitle,
  icon,
  accent,
  count,
  tone,
  layout = 'grid',
  onPress,
}: MasterCardProps) {
  const attention = (tone ?? (accent === colors.accent ? 'attention' : 'neutral')) === 'attention';
  const wellBg = attention ? colors.tintCoral : colors.tintTeal;
  const wellInk = attention ? colors.accent : colors.primary;

  // Identical content in both layouts — only the arrangement differs. Labels,
  // subtitles and counts are never abbreviated for the grid.
  const badge = (
    <View style={[styles.iconBadge, { backgroundColor: wellBg }]}>
      <Ionicons name={icon as any} size={20} color={wellInk} />
    </View>
  );
  const pill = (
    <View style={[styles.countPill, { backgroundColor: wellBg }]}>
      <Text style={[styles.cardCount, { color: wellInk }]}>
        {count == null ? '—' : count.toLocaleString()}
      </Text>
    </View>
  );
  const a11y = `${label}. ${subtitle}${count == null ? '' : `. ${count}`}`;

  if (layout === 'row') {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        style={({ pressed }) => [styles.cardWrapper, pressed && styles.cardPressed]}
      >
        {badge}
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>{label}</Text>
          <Text style={styles.cardSubtitle}>{subtitle}</Text>
        </View>
        {pill}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => [styles.gridCard, pressed && styles.cardPressed]}
    >
      <View style={styles.gridTop}>
        {badge}
        {pill}
      </View>
      <View style={styles.gridText}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {label}
        </Text>
        <Text style={styles.cardSubtitle} numberOfLines={3}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Two-column wrapper for navigation menu cards.
 *
 * Percentage widths rather than a fixed column count so the row reflows on a
 * narrow phone instead of overflowing; `gap` handles the gutter, so no card
 * needs a margin that would break the alignment of the last row.
 */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  gridCard: {
    // Just under half, so two fit beside one `gap` without rounding overflow.
    // NOT flexGrow: with an odd number of cards the last one would stretch to
    // the full width and stop reading as part of a grid at all.
    width: '48%',
    minHeight: 148,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'space-between',
  },
  gridTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  gridText: { gap: 2 },
  cardWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardPressed: { opacity: 0.75 },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardText: { flex: 1, minWidth: 0, gap: 2 },
  cardTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  cardSubtitle: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
  },
  countPill: {
    minWidth: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  cardCount: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
  },
});

export default MasterCard;
