/**
 * Business Overview — the dashboard metrics block.
 *
 * A section heading, then a row of cards: tinted icon badge, label, figure,
 * and — where real history exists — a month-on-month delta and a sparkline.
 *
 * WHAT REPLACED WHAT
 * ------------------
 * This supersedes `StatGrid`'s two-column cards, which put the figure above the
 * label and carried no trend. Every dashboard uses this one, so there is a
 * single metrics pattern rather than two competing ones.
 *
 * FOUR ACCENTS, NOT TWO
 * ---------------------
 * The rest of the app is deliberately two-colour (teal / coral — see theme.ts).
 * The metrics block is the exception: four accents let a row of four cards be
 * told apart at a glance, which is the whole point of a row of four cards. They
 * are tokens here rather than literals at each call site so the set stays fixed.
 *
 * `delta` AND `trend` ARE OPTIONAL, AND OFTEN ABSENT
 * --------------------------------------------------
 * Most of these figures are live queue depths — "pending stage QA", "low stock
 * items". Nothing records what they were last month, so there is no delta to
 * show and no series to plot. Those cards render without the trend row, and
 * that is the honest result: the alternative is a chart of numbers nobody
 * measured. Cards over a CUMULATIVE quantity (total factories, total damage
 * records) can be plotted from the rows' own timestamps, and those carry one.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Sparkline } from './Sparkline';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  metricAccents,
  type MetricAccent,
} from '../../constants/theme';

export interface MetricDelta {
  /** Whole percent, unsigned. */
  pct: number;
  direction: 'up' | 'down';
  /** What it is measured against — "vs last month" by default. */
  since?: string;
}

export interface MetricCardProps {
  label: string;
  /** Already formatted. This component never rounds or invents a figure. */
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
  accent?: MetricAccent;
  /** Print the figure in the accent colour — for the one money card in a row. */
  emphasis?: boolean;
  /** Real change against the previous period. Omit when nothing recorded it. */
  delta?: MetricDelta | null;
  /** Real series, oldest to newest. Omit when there is no history. */
  trend?: number[] | null;
  onPress?: () => void;
}

export function MetricCard({
  label,
  value,
  icon,
  accent = 'teal',
  emphasis,
  delta,
  trend,
  onPress,
}: MetricCardProps) {
  const a = metricAccents[accent];
  const hasTrend = !!trend && trend.length > 1;
  // Up is not automatically good — "damage records up 12%" is bad news. The
  // caller says which accent the card carries; the arrow only states direction.
  const deltaColor = delta?.direction === 'up' ? metricAccents.green.ink : metricAccents.rose.ink;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={
        `${value} ${label}` +
        (delta ? `, ${delta.direction} ${delta.pct}% ${delta.since ?? 'vs last month'}` : '')
      }
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: a.card },
        pressed && onPress ? styles.pressed : null,
      ]}
    >
      <View style={[styles.badge, { backgroundColor: a.tint }]}>
        <Ionicons name={icon} size={19} color={a.ink} />
      </View>

      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>

      <View style={styles.figureRow}>
        <View style={styles.figureCol}>
          <Text
            style={[styles.value, emphasis && { color: a.ink }]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {value}
          </Text>

          {delta ? (
            <View style={styles.deltaRow}>
              <View style={[styles.deltaDot, { backgroundColor: deltaColor }]}>
                <Ionicons
                  name={delta.direction === 'up' ? 'arrow-up' : 'arrow-down'}
                  size={9}
                  color={colors.white}
                />
              </View>
              <Text style={[styles.deltaPct, { color: deltaColor }]}>{delta.pct}%</Text>
              <Text style={styles.deltaSince} numberOfLines={1}>
                {delta.since ?? 'vs last month'}
              </Text>
            </View>
          ) : null}
        </View>

        {hasTrend ? <Sparkline data={trend as number[]} color={a.ink} /> : null}
      </View>
    </Pressable>
  );
}

/**
 * The row of cards.
 *
 * Four across on a desktop width, two on a phone. `StatGrid`'s `flexBasis: 46%`
 * made two ~940px cards on a wide screen — the grid was written for a phone and
 * never told otherwise. This measures the window and picks a column count.
 */
export function MetricRow({ children }: { children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const columns = width >= 1100 ? 4 : width >= 760 ? 3 : 2;
  const items = React.Children.toArray(children);

  return (
    <View style={styles.row}>
      {items.map((child, i) => (
        <View
          key={i}
          style={[
            styles.cell,
            // Percentage basis minus the gap the row puts between cells.
            { flexBasis: `${100 / columns}%`, maxWidth: `${100 / columns}%` },
          ]}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

/** Heading above the row: title, one-line subtitle, and space for a control. */
export function MetricsSection({
  title = 'Business Overview',
  subtitle = 'Key insights at a glance',
  right,
  children,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.sectionSubtitle}>{subtitle}</Text>
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  sectionSubtitle: {
    marginTop: 2,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.caption,
    color: colors.inkMuted,
  },

  row: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs },
  cell: { paddingHorizontal: spacing.xs, paddingBottom: spacing.md },

  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    minHeight: 118,
  },
  pressed: { opacity: 0.8 },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  label: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
  },
  figureRow: {
    marginTop: spacing.xs,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  figureCol: { flex: 1, minWidth: 0 },
  value: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  deltaRow: { marginTop: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: 4 },
  deltaDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deltaPct: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
  },
  deltaSince: { flexShrink: 1, fontSize: fontSize.caption, color: colors.inkSubtle },
});

export default MetricCard;
