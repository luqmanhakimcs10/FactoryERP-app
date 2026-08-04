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
  handover_for_delivery: 'Handover for Delivery',
  awaiting_dp_collection: 'Awaiting Collection',
  handed_over: 'Handed Over',
  in_production: 'In Production',
  in_finishing: 'In Finishing',
  handed_off: 'At Finishing Partner',
  returned_to_delivery: 'Collected from Partner',
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
 */
const DELIVERY_STATUS_LABEL: Record<string, string> = {
  awaiting_dp_collection: 'To Collect',
  handed_over: 'Delivery waiting',
  handed_off: 'Out at Partner',
  returned_to_delivery: 'Collected — hand back',
};

const REPEAT_STATUS_COLOR: Record<string, string> = {
  coded: colors.inkMuted,
  awaiting_job_card: colors.accent,
  ready_for_production: colors.primary,
  awaiting_stage: colors.inkMuted,
  in_progress: colors.primary,
  stage_qa: colors.primary,
  handover_for_delivery: colors.primary,
  awaiting_dp_collection: colors.accent,
  handed_over: colors.accent,
  in_production: colors.primary,
  in_finishing: colors.primary,
  handed_off: colors.accent,
  returned_to_delivery: colors.primary,
  awaiting_fm_collection: colors.accent,
  awaiting_collection_qa: colors.accent,
  awaiting_final_qa: colors.accent,
  awaiting_qa_final: colors.accent,
  completed: colors.primary,
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
  return <StatusPill label={label} color={REPEAT_STATUS_COLOR[status] ?? colors.slate} />;
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
