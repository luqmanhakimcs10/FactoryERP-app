/**
 * Root navigator. Decides between the auth stack (logged out) and the role
 * router (logged in), and shows a splash while the session is restored at launch.
 */
import React from 'react';
import { View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../auth/AuthContext';
import { LoginScreen } from '../screens/shared/LoginScreen';
import { RoleRouter } from './RoleRouter';
import { PartnerPortalScreen } from '../screens/finishingPartner/PartnerPortalScreen';
import { partnerTokenFromUrl } from '../utils/partnerLink';
import { colors, fontSize, spacing, fontWeight } from '../constants/theme';

const Stack = createNativeStackNavigator();

function Splash() {
  return (
    <View style={styles.splash}>
      <Text style={styles.wordmark}>FACTORY ERP</Text>
      <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
    </View>
  );
}

export function RootNavigator() {
  const { initializing, hydrating, session } = useAuth();

  /**
   * The finishing partner's link, if this is one.
   *
   * Read ONCE, before anything else decides what to render: a partner opening
   * their bookmark has no account, so waiting on the session restore would show
   * them a splash and then a login screen they can never get past. Read from
   * the URL at mount and never re-read — the token cannot change without a
   * page load, and re-reading on every render would fight React Query's
   * refetches for no gain.
   */
  const [partnerToken] = React.useState(partnerTokenFromUrl);
  if (partnerToken) return <PartnerPortalScreen token={partnerToken} />;

  // Splash during launch restore and during the post-login profile fetch,
  // so the user never sees a flash of the wrong stack.
  if (initializing || hydrating) return <Splash />;

  // A session means signed in; RoleRouter handles the "no profile" (unseeded) case.
  const isAuthed = !!session;

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isAuthed ? (
          <Stack.Screen name="App" component={RoleRouter} />
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: {
    fontSize: 30,
    letterSpacing: 2,
    color: colors.indigo,
    fontWeight: fontWeight.semibold,
  },
});
