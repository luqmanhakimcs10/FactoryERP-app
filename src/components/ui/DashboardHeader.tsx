/**
 * The dashboard/home header: a teal block with rounded bottom corners carrying
 * a coral initials avatar, "Hi, [Name]" greeting, the factory name beneath, the
 * notification bell top-right, and — where the screen wants one — a full-width
 * white search bar.
 *
 * This is the home-screen form of the header. Inner/detail screens keep the
 * back-arrow + title + role-badge form in `AppHeader`; both draw from the same
 * palette so they read as one system.
 *
 * Purely presentational: it renders the identity the session already has and
 * owns no navigation or data behaviour of its own beyond the bell (which is the
 * same `QueueBell` the inner header uses).
 */
import React from 'react';
import { View, Text, TextInput, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { QueueBell } from './QueueBell';
import { useAuth } from '../../auth/AuthContext';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

// Mirrors AppHeader's list exactly: these roles reach SLA Alerts from the
// header and nowhere else, so the home screen must keep offering it.
const SLA_ALERT_ROLES = new Set(['qa', 'floor_manager', 'company_admin']);

interface Props {
  /**
   * Search box under the greeting. Omit `onSearchChange` to hide the bar —
   * a screen that has nothing to search should not show a dead control.
   */
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  searchPlaceholder?: string;
  /** Extra content rendered inside the teal block, below the search bar. */
  children?: React.ReactNode;
  navigation?: any;
}

/** "Imran Khan" -> "IK"; "Imran" -> "IM". Never renders empty. */
function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** First name only — the greeting is meant to read like a person said it. */
function firstNameOf(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/).filter(Boolean)[0];
  return first ?? 'there';
}

export function DashboardHeader({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search',
  children,
  navigation,
}: Props) {
  const insets = useSafeAreaInsets();
  const { profile, factory, role, signOut } = useAuth();

  const factoryName = factory?.name ?? (role === 'super_admin' ? 'Platform' : '—');

  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.md }]}>
      <View style={styles.greetRow}>
        <View style={styles.avatar} accessibilityElementsHidden importantForAccessibility="no">
          <Text style={styles.avatarText}>{initialsOf(profile?.display_name)}</Text>
        </View>

        <View style={styles.greetText}>
          <Text style={styles.greeting} numberOfLines={1}>
            Hi, {firstNameOf(profile?.display_name)}
          </Text>
          <Text style={styles.factory} numberOfLines={1}>
            {factoryName}
          </Text>
        </View>

        {/* Same three controls the inner-screen header carries, in the
            reference's circular treatment. None of them are new and none are
            dropped: for several roles the home screen is the ONLY screen, so
            losing sign-out or SLA alerts here would strand them. */}
        <View style={styles.actions}>
          <QueueBell variant="circle" />
          {SLA_ALERT_ROLES.has(role ?? '') ? (
            <Pressable
              accessibilityLabel="SLA Alerts"
              accessibilityRole="button"
              onPress={() => navigation?.navigate?.('SlaAlerts')}
              style={({ pressed }) => [styles.circleBtn, pressed && styles.pressed]}
            >
              <Ionicons name="alarm-outline" size={20} color={colors.white} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Sign out"
            accessibilityRole="button"
            onPress={signOut}
            style={({ pressed }) => [styles.circleBtn, pressed && styles.pressed]}
          >
            <Ionicons name="log-out-outline" size={20} color={colors.white} />
          </Pressable>
        </View>
      </View>

      {onSearchChange ? (
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.inkSubtle} />
          <TextInput
            style={styles.searchInput}
            value={searchValue}
            onChangeText={onSearchChange}
            placeholder={searchPlaceholder}
            placeholderTextColor={colors.inkSubtle}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {searchValue ? (
            <Pressable
              onPress={() => onSearchChange('')}
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={18} color={colors.inkSubtle} />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {children}
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
  },
  greetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: fontFamily.displayBold,
    color: colors.white,
    fontSize: fontSize.body,
    fontWeight: fontWeight.bold,
  },
  greetText: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  pressed: { opacity: 0.6 },
  greeting: {
    fontFamily: fontFamily.displayBold,
    color: colors.white,
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
  },
  factory: {
    fontFamily: fontFamily.sansMedium,
    marginTop: 1,
    color: 'rgba(255,255,255,0.78)',
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    color: colors.ink,
    paddingVertical: spacing.sm,
  },
});

export default DashboardHeader;
