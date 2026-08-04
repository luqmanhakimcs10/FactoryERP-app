/**
 * The header's notification bell.
 *
 * Shows how much work is currently waiting on YOU, across every queue your role
 * owns, and lists the breakdown when tapped.
 *
 * DELIBERATELY NON-BLOCKING, per the brief. No modal, no acknowledgement, no
 * navigation side effects: the panel is an absolutely-positioned overlay that
 * closes on the next tap and never sits in front of a control the user was
 * about to press. Nothing in the app waits on it, and if the query fails the
 * bell simply renders without a badge — a notification affordance must not be
 * able to break the header it lives in.
 *
 * "Waiting on you" rather than "new since you last looked": unread-tracking
 * needs per-user seen-state and goes subtly wrong the moment two people share a
 * role or an item is actioned from another screen. A pending count still rises
 * the instant new work lands, which is what the bell is for, and it cannot lie.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { getQueueSummary } from '../../api/endpoints/stageHandover';
import { useAuth } from '../../auth/AuthContext';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  elevation,
} from '../../constants/theme';

interface QueueBellProps {
  /**
   * `circle` renders the bell in a translucent-white round button, for the
   * teal dashboard header. `plain` is the bare icon used in the inner-screen
   * header. Behaviour and counts are identical either way.
   */
  variant?: 'plain' | 'circle';
}

export function QueueBell({ variant = 'plain' }: QueueBellProps = {}) {
  const [open, setOpen] = useState(false);
  const { profile } = useAuth();

  const { data, isLoading, isError } = useQuery({
    // Keyed by user: these counts are per-role, so a shared key would show the
    // previous person's badge after a sign-out/sign-in on the same device until
    // the next refetch. (Sign-out clears the cache too — belt and braces,
    // because the wrong number on a notification badge is worse than none.)
    queryKey: ['queueSummary', profile?.id ?? 'anon'],
    queryFn: getQueueSummary,
    // Work arrives from other people, so this is one of the few places polling
    // earns its keep. A minute is frequent enough to feel live and slow enough
    // to be invisible.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // A failed bell must never surface as an error state in the header.
    retry: false,
    enabled: !!profile?.id,
  });

  const rows = isError ? [] : (data ?? []);
  const total = rows.reduce((n, r) => n + Number(r.count ?? 0), 0);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          total > 0 ? `Notifications, ${total} item${total === 1 ? '' : 's'} waiting` : 'Notifications'
        }
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        style={({ pressed }) => [
          styles.iconBtn,
          variant === 'circle' && styles.iconBtnCircle,
          pressed && styles.pressed,
        ]}
      >
        <Ionicons name="notifications-outline" size={22} color={colors.white} />
        {total > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText} numberOfLines={1}>
              {total > 99 ? '99+' : total}
            </Text>
          </View>
        ) : null}
      </Pressable>

      {open ? (
        <>
          {/* Tap-away catcher, mounted only while the panel is open. One tap
              anywhere dismisses; nothing has to be acknowledged. */}
          <Pressable
            style={styles.backdrop}
            accessibilityLabel="Close notifications"
            onPress={() => setOpen(false)}
          />
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Waiting on you</Text>
            <View style={styles.stitch} />

            {isLoading ? (
              <ActivityIndicator color={colors.indigo} style={{ marginVertical: spacing.md }} />
            ) : rows.length === 0 ? (
              <Text style={styles.empty}>
                {isError ? 'Could not load your queues just now.' : 'Nothing waiting — you are all caught up.'}
              </Text>
            ) : (
              rows.map((r) => (
                <View key={r.queue_key} style={styles.row}>
                  <Text style={styles.rowLabel} numberOfLines={2}>
                    {r.label}
                  </Text>
                  <View style={styles.count}>
                    <Text style={styles.countText}>{r.count}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  iconBtn: { padding: spacing.xs, borderRadius: radius.sm },
  iconBtnCircle: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    // Translucent white over the teal header — reads as a button without
    // introducing another opaque surface colour.
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  pressed: { opacity: 0.6 },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.alert,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: fontWeight.semibold },
  backdrop: {
    // Only mounted while the panel is OPEN, which is the property that matters:
    // a closed bell intercepts nothing at all. While open it is transparent —
    // it dims nothing — but it does consume the tap that dismisses the panel,
    // which is ordinary popover behaviour and not an acknowledgement gate.
    position: 'absolute',
    top: -1000,
    left: -1000,
    right: -1000,
    bottom: -1000,
  },
  panel: {
    position: 'absolute',
    top: 34,
    right: 0,
    minWidth: 260,
    maxWidth: 320,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.lg,
    zIndex: 50,
  },
  panelTitle: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  stitch: {
    marginVertical: spacing.sm,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: colors.brass,
    opacity: 0.5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  rowLabel: { flex: 1, fontSize: fontSize.caption, color: colors.indigoDeep },
  count: {
    minWidth: 24,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.indigo,
    alignItems: 'center',
  },
  countText: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  empty: { fontSize: fontSize.caption, color: colors.slate, paddingVertical: spacing.xs },
});

export default QueueBell;
