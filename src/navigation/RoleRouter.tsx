/**
 * Role router — after login, the user's role selects which of the 11
 * role-specific navigators mounts. This is the single branch point for the
 * whole authenticated app.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { ROLE_NAVIGATORS } from './roles';
import { Screen } from '../components/ui/Screen';
import { colors, spacing, fontSize } from '../constants/theme';

export function RoleRouter() {
  const { role, profile } = useAuth();

  // Signed in but no usable profile/role (e.g. not seeded) — fail cleanly.
  if (!role || !ROLE_NAVIGATORS[role]) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.title}>Account not set up</Text>
          <Text style={styles.body}>
            {profile
              ? `Your role "${profile.role}" has no assigned workspace. Contact your administrator.`
              : 'No profile is linked to this login yet. Contact your administrator.'}
          </Text>
        </View>
      </Screen>
    );
  }

  const RoleNavigator = ROLE_NAVIGATORS[role];
  return <RoleNavigator />;
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', gap: spacing.sm },
  title: { fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: '600' },
  body: { fontSize: fontSize.body, color: colors.slate, lineHeight: 22 },
});
