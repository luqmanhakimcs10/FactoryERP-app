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
