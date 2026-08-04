/**
 * The stage-progress stitch line — the app's signature motif.
 *
 * A horizontal dashed rule (a row of stitches) with a solid brass dot at the
 * current stage, hollow dots ahead, and completed stages filled success green.
 *
 * The steps are always passed in from `order_timeline()`, which derives them from
 * repeat_stage_history and the order's own order_stages — never from a hardcoded
 * step list, so an order configured embroidery → clipping → press shows exactly
 * those stages.
 *
 * Every dot carries a text label and each step states its status in words, so the
 * progression never depends on colour perception alone (quality floor).
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, fontWeight } from '../../constants/theme';
import type { TimelineStep } from '../../models/orderTypes';

interface Props {
  steps: TimelineStep[];
  /** Vertical reads better on a phone for long sequences; horizontal for compact. */
  orientation?: 'vertical' | 'horizontal';
}

const STATE_COLOR: Record<TimelineStep['state'], string> = {
  done: colors.success,
  current: colors.primary,
  ahead: colors.border,
};

const STATE_WORD: Record<TimelineStep['state'], string> = {
  done: 'Done',
  current: 'In progress',
  ahead: 'Not started',
};

export function StageProgress({ steps, orientation = 'vertical' }: Props) {
  if (!steps.length) return null;
  return orientation === 'horizontal' ? (
    <HorizontalLine steps={steps} />
  ) : (
    <VerticalLine steps={steps} />
  );
}

/** Compact horizontal stitch line — for list rows and headers. */
function HorizontalLine({ steps }: { steps: TimelineStep[] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.hRow}>
        {steps.map((s, i) => (
          <View key={s.step_key} style={styles.hStep}>
            <View style={styles.hDotRow}>
              <Dot state={s.state} />
              {i < steps.length - 1 ? <Stitches state={s.state} /> : null}
            </View>
            <Text style={styles.hLabel} numberOfLines={1}>
              {s.label}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** Full vertical timeline — the status tracker screen. */
function VerticalLine({ steps }: { steps: TimelineStep[] }) {
  return (
    <View>
      {steps.map((s, i) => (
        <View key={s.step_key} style={styles.vRow}>
          <View style={styles.vRail}>
            <Dot state={s.state} />
            {i < steps.length - 1 ? <VStitches state={s.state} /> : null}
          </View>

          <View style={styles.vBody}>
            <Text style={styles.vLabel}>{s.label}</Text>
            <Text style={[styles.vState, { color: STATE_COLOR[s.state] === colors.border ? colors.slate : STATE_COLOR[s.state] }]}>
              {STATE_WORD[s.state]}
              {s.at ? ` · ${formatWhen(s.at)}` : ''}
            </Text>
            {s.detail ? <Text style={styles.vDetail}>{s.detail}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Dot({ state }: { state: TimelineStep['state'] }) {
  if (state === 'done') {
    return (
      <View style={[styles.dot, { backgroundColor: colors.success, borderColor: colors.success }]}>
        <Ionicons name="checkmark" size={12} color={colors.white} />
      </View>
    );
  }
  if (state === 'current') {
    // Solid brass dot marks where the work actually is.
    return <View style={[styles.dot, { backgroundColor: colors.brass, borderColor: colors.brass }]} />;
  }
  // Hollow dot for stages ahead.
  return <View style={[styles.dot, { backgroundColor: 'transparent', borderColor: colors.border }]} />;
}

/** Horizontal run of stitches between two dots. */
function Stitches({ state }: { state: TimelineStep['state'] }) {
  const color = state === 'done' ? colors.success : colors.border;
  return (
    <View style={styles.stitchRun}>
      {Array.from({ length: 6 }).map((_, i) => (
        <View key={i} style={[styles.stitch, { backgroundColor: color }]} />
      ))}
    </View>
  );
}

function VStitches({ state }: { state: TimelineStep['state'] }) {
  const color = state === 'done' ? colors.success : colors.border;
  return (
    <View style={styles.vStitchRun}>
      {Array.from({ length: 4 }).map((_, i) => (
        <View key={i} style={[styles.vStitch, { backgroundColor: color }]} />
      ))}
    </View>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  // horizontal
  hRow: { flexDirection: 'row', paddingVertical: spacing.sm },
  hStep: { marginRight: spacing.xs },
  hDotRow: { flexDirection: 'row', alignItems: 'center' },
  hLabel: {
    marginTop: spacing.xs,
    fontSize: fontSize.caption,
    color: colors.slate,
    maxWidth: 92,
  },
  stitchRun: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 4 },
  stitch: { width: 5, height: 2, borderRadius: 1, marginRight: 3 },

  // vertical
  vRow: { flexDirection: 'row', gap: spacing.md },
  vRail: { alignItems: 'center', width: 20 },
  vStitchRun: { alignItems: 'center', flex: 1, paddingVertical: 2, minHeight: 26 },
  vStitch: { width: 2, height: 5, borderRadius: 1, marginBottom: 3 },
  vBody: { flex: 1, paddingBottom: spacing.lg },
  vLabel: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  vState: { marginTop: 2, fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  vDetail: { marginTop: 2, fontSize: fontSize.secondary, color: colors.slate },

  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
