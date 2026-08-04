/**
 * Persistent header across every role navigator:
 * back control (when the stack can go back), screen/factory context, role badge,
 * notification bell (UI slot only — no alert data yet), and sign-out.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { QueueBell } from './QueueBell';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';
import { ROLE_LABEL } from '../../constants/roles';
import { useAuth } from '../../auth/AuthContext';

interface Props {
  /** Screen title — shown instead of the factory name on nested screens. */
  title?: string;
  /** True when the stack has somewhere to go back to. */
  canGoBack?: boolean;
  onBack?: () => void;
  navigation?: any;
}

// `delivery` is deliberately absent: that role now has exactly ONE screen
// (Orders), and SLA urgency is shown inline on the rows themselves — breached
// items sort to the top and carry an alert pill. A header button navigating to
// a route the delivery navigator no longer registers would just dead-end.
const SLA_ALERT_ROLES = new Set(['qa', 'floor_manager', 'company_admin']);

export function AppHeader({ title, canGoBack, onBack, navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { factory, role, signOut } = useAuth();

  const factoryName = factory?.name ?? (role === 'super_admin' ? 'Platform' : '—');
  // On nested screens show where you are; on the role home show the factory.
  const heading = canGoBack && title ? title : factoryName;

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm }]}>
      {canGoBack ? (
        <Pressable
          onPress={onBack}
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={24} color={colors.white} />
        </Pressable>
      ) : null}

      <View style={styles.left}>
        <Text style={styles.heading} numberOfLines={1}>
          {heading}
        </Text>
        {role ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{ROLE_LABEL[role]}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.right}>
        {/* The bell now reports what is waiting across ALL of this role's
            queues, so it is useful to every role rather than only the three
            that had SLA alerts. SLA breaches are still surfaced inline on the
            rows they belong to. */}
        <QueueBell />
        {SLA_ALERT_ROLES.has(role ?? '') ? (
          <Pressable
            accessibilityLabel="SLA Alerts"
            accessibilityRole="button"
            onPress={() => navigation?.navigate?.('SlaAlerts')}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <Ionicons name="alarm-outline" size={22} color={colors.white} />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel="Sign out"
          accessibilityRole="button"
          onPress={signOut}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        >
          <Ionicons name="log-out-outline" size={22} color={colors.white} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  left: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heading: {
    fontFamily: fontFamily.displayBold,
    color: colors.white,
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    flexShrink: 1,
  },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  badgeText: {
    fontFamily: fontFamily.sansSemibold,
    color: colors.white,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
  },
  right: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconBtn: { padding: spacing.xs },
  pressed: { opacity: 0.6 },
});
