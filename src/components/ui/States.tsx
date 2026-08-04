/**
 * Shared empty and loading states.
 *
 * Both exist so no screen ever renders a blank rectangle. An empty list should
 * say what will appear there once work arrives; a loading list should show the
 * SHAPE of what is coming rather than a bare spinner, which makes the wait feel
 * shorter and stops the layout jumping when data lands.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  tint,
  tracking,
} from '../../constants/theme';

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
interface EmptyProps {
  /** Any Ionicon — keep to the outline set for consistency with the app. */
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  /** One line explaining what shows up here once there is data. */
  message?: string;
  /** Optional call to action, e.g. a "+ New order" button. */
  action?: React.ReactNode;
}

export function EmptyState({ icon = 'file-tray-outline', title, message, action }: EmptyProps) {
  return (
    <View style={styles.emptyWrap}>
      <View style={styles.iconWell}>
        <Ionicons name={icon} size={26} color={colors.slate} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMsg}>{message}</Text> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
/** A single shimmering block — the building piece of a skeleton. */
export function Skeleton({
  width = '100%',
  height = 14,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  style?: object;
}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] });

  return (
    <Animated.View
      style={[{ width, height, borderRadius: radius.sm, backgroundColor: colors.border, opacity }, style]}
    />
  );
}

/** Skeleton shaped like the app's standard list row. Use while a list loads. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <View accessibilityLabel="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={styles.skelRow}>
          <View style={{ flex: 1, gap: spacing.sm }}>
            <Skeleton width="52%" height={15} />
            <Skeleton width="34%" height={12} />
          </View>
          <Skeleton width={68} height={22} style={{ borderRadius: radius.pill }} />
        </View>
      ))}
    </View>
  );
}

/** Branded spinner for actions and small areas where a skeleton is overkill. */
export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.loadingWrap}>
      <ActivityIndicator color={colors.primary} />
      {label ? <Text style={styles.loadingText}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  emptyWrap: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.xl, gap: spacing.sm },
  iconWell: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: tint(colors.slate, 0.1),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    textAlign: 'center',
    letterSpacing: tracking.tight,
  },
  emptyMsg: {
    fontSize: fontSize.secondary,
    color: colors.slate,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  },
  emptyAction: { marginTop: spacing.md },
  skelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 72,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  loadingWrap: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  loadingText: { fontSize: fontSize.secondary, color: colors.slate },
});
