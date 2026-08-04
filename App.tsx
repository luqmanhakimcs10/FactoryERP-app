import 'react-native-url-polyfill/auto';
import React from 'react';
import { View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';
import { Poppins_600SemiBold, Poppins_700Bold } from '@expo-google-fonts/poppins';
import { IBMPlexMono_400Regular, IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono';
import { AuthProvider } from './src/auth/AuthContext';
import { NextStepProvider } from './src/components/ui/NextStepToast';
import { RootNavigator } from './src/navigation/RootNavigator';
import { colors, fontFamily } from './src/constants/theme';

// Server state (orders, shifts, ledgers, ...) flows through React Query.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/**
 * Apply Inter as the app-wide default body face.
 *
 * React Native has no CSS cascade, but react-native-web renders to the DOM,
 * where there is one. Setting the family on the root lets every node that does
 * NOT declare its own family inherit Inter — while anything that explicitly
 * asks for `fontFamily.display` (headings) or `fontFamily.mono` (codes,
 * reference numbers) keeps that face, because a declared family beats an
 * inherited one.
 *
 * `Text.defaultProps` is deliberately not used: it was removed in React 19, so
 * it silently does nothing.
 */
function useDefaultFont(ready: boolean) {
  React.useEffect(() => {
    if (!ready || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const id = 'factory-erp-base-font';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = `
      #root, body {
        font-family: '${fontFamily.sans}', system-ui, -apple-system, Segoe UI, sans-serif;
      }
    `;
    document.head.appendChild(el);
  }, [ready]);
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Poppins_600SemiBold,
    Poppins_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_600SemiBold,
  });

  useDefaultFont(fontsLoaded);

  // Hold the shell until the faces are ready — a flash of system font then a
  // reflow into Inter/Poppins looks broken, and the wait is a few hundred ms.
  if (!fontsLoaded) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="light" />
          <NextStepProvider>
            <RootNavigator />
          </NextStepProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
