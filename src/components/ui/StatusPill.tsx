/**
 * Status pill. Always carries a text label — colour is a reinforcement, never
 * the sole signal (factory lighting washes out subtle hues).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  pillTint,
  tint,
  tracking,
} from '../../constants/theme';
import type { OrderStatus } from '../../models/orderTypes';
import { ORDER_STATUS_LABEL } from '../../models/orderTypes';

// Two-colour system: teal = in-flight / done / routine, coral = waiting on
// someone or gone wrong, muted = not started. The LABELS are unchanged — only
// which of the two tints carries them.
const ORDER_STATUS_COLOR: Record<OrderStatus, string> = {
  draft: colors.inkMuted,
  awaiting_procurement: colors.accent,
  awaiting_cloth_inspection: colors.accent,
  awaiting_coding: colors.accent,
  awaiting_job_card: colors.accent,
  job_card_shared: colors.primary,
  job_card_confirmed: colors.primary,
  machine_selection_pending: colors.accent,
  in_production: colors.primary,
  in_finishing: colors.primary,
  awaiting_final_qa: colors.accent,
  ready_for_delivery: colors.primary,
  completed: colors.primary,
  cancelled: colors.accent,
};

export function OrderStatusPill({ status }: { status: OrderStatus }) {
  return (
    <StatusPill label={ORDER_STATUS_LABEL[status] ?? status} color={ORDER_STATUS_COLOR[status] ?? colors.slate} />
  );
}

const REPEAT_STATUS_LABEL: Record<string, string> = {
  coded: 'Coded',
  awaiting_job_card: 'Awaiting Job Card',
  ready_for_production: 'Ready for Production',
  // Retired by 0056 — a stage now opens straight at In Progress. Kept so old
  // history rows still render as words rather than a raw column value.
  awaiting_stage: 'Awaiting Stage',
  in_progress: 'In Progress',
  stage_qa: 'Stage QA',
  handover_for_delivery: 'Ready to Hand Over',
  // Retired by 0092 — the Floor Manager's handover IS the collection, and the
  // delivery person delivers to the Inspector rather than handing back. Both
  // are kept so old history rows still render as words, not column values.
  awaiting_dp_collection: 'Awaiting Collection',
  handed_over: 'With Delivery Person',
  in_production: 'In Production',
  in_finishing: 'In Finishing',
  handed_off: 'At Finishing Partner',
  returned_to_delivery: 'Collected — going to the Inspector',
  awaiting_fm_collection: 'Awaiting Floor Collection',
  awaiting_collection_qa: 'Awaiting QA Collection',
  awaiting_final_qa: 'Awaiting Final QA',
  awaiting_qa_final: 'With QA — Final Pass',
  completed: 'Completed',
  damaged: 'Damaged',
};

/**
 * The Delivery Person sees the same physical states from the other side, so a
 * few statuses read differently for them. `handed_over` is the clearest case:
 * to the floor it means "gone", to the delivery person it means "in my hands,
 * waiting to go out" — one fact, two vantage points (see 0056's header).
 *
 * These four ARE the four statuses of their cycle (0092), in order:
 *   Delivery -> In Pickup -> Delivery -> Completion
 * The first and third are the same DB status seen twice, going in opposite
 * directions, which is why `returned_to_delivery` reads as a delivery here.
 */
const DELIVERY_STATUS_LABEL: Record<string, string> = {
  handed_over: 'Delivery — to the partner',
  handed_off: 'In Pickup',
  returned_to_delivery: 'Delivery — to the Inspector',
  stage_qa: 'Completion',
  // Retired; kept so a stale cached row still reads as words.
  awaiting_dp_collection: 'To Collect',
  awaiting_fm_collection: 'Handed back',
};

/**
 * A repeat's pill is a PROGRESS display, so it follows the progress palette:
 * green means this piece is finished, orange means work is happening on it
 * right now, coral means something has gone wrong, muted means not started.
 *
 * This is the one place the two-colour rule bends, for the reason set out on
 * `colors.progressDone`: on a stage-tracking table every row is in-flight, so
 * colouring them all teal said nothing. Damage and the SLA breach keep coral —
 * "gone wrong" must not read as "in progress".
 */
const REPEAT_STATUS_COLOR: Record<string, string> = {
  coded: colors.inkMuted,
  awaiting_job_card: colors.inkMuted,
  ready_for_production: colors.inkMuted,
  awaiting_stage: colors.inkMuted,
  in_progress: colors.progressActive,
  stage_qa: colors.progressActive,
  handover_for_delivery: colors.progressActive,
  awaiting_dp_collection: colors.progressActive,
  handed_over: colors.progressActive,
  in_production: colors.progressActive,
  in_finishing: colors.progressActive,
  handed_off: colors.progressActive,
  returned_to_delivery: colors.progressActive,
  awaiting_fm_collection: colors.progressActive,
  awaiting_collection_qa: colors.progressActive,
  awaiting_final_qa: colors.progressActive,
  awaiting_qa_final: colors.progressActive,
  completed: colors.progressDone,
  damaged: colors.accent,
};

export function RepeatStatusPill({
  status,
  detail,
  perspective = 'floor',
}: {
  status: string;
  detail?: string | null;
  /** 'delivery' swaps in the Delivery Person's wording for shared statuses. */
  perspective?: 'floor' | 'delivery';
}) {
  const base =
    (perspective === 'delivery' ? DELIVERY_STATUS_LABEL[status] : undefined) ??
    REPEAT_STATUS_LABEL[status] ??
    status;
  // The stage name matters most while the piece is actually being worked or is
  // out of the building — that is when "which stage?" is the live question.
  const withStage = ['in_progress', 'handover_for_delivery', 'handed_off', 'awaiting_fm_collection'];
  const label = withStage.includes(status) && detail ? `${base} — ${detail}` : base;
  // `stage_qa` is the one status the two perspectives disagree about in kind,
  // not just in wording: to the floor the piece is mid-inspection (orange), to
  // the delivery person their leg of it is finished (green). Same row, two
  // true answers — the same "one status, two labels" rule as the text above.
  const color =
    perspective === 'delivery' && status === 'stage_qa'
      ? colors.progressDone
      : REPEAT_STATUS_COLOR[status] ?? colors.slate;
  return <StatusPill label={label} color={color} />;
}

export function StatusPill({ label, color }: { label: string; color: string }) {
  // Tinted pill: a light wash of the semantic colour carrying that colour at
  // full strength as ink. Contrast is comfortably above 4.5:1 for both tints,
  // and the label always carries the meaning — colour only reinforces it.
  const { bg, ink } = pillTint(color);

  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.text, { color: ink }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  text: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    letterSpacing: tracking.normal,
  },
});
