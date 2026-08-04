/**
 * Single Supabase client for the whole app.
 * Session is persisted with AsyncStorage so it survives an app restart (Phase 1 DoD).
 *
 * NOTE: No screen or component may import supabase directly — go through the
 * thin API layer in src/api/endpoints/*. This file is the only place the client lives.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** True when real credentials are present. The UI shows a setup hint when false. */
export const isSupabaseConfigured =
  !!supabaseUrl &&
  !!supabaseAnonKey &&
  !supabaseUrl.includes('YOUR_') &&
  !supabaseAnonKey.includes('YOUR_');

if (!isSupabaseConfigured) {
  // Don't crash the bundle — let the login screen render a helpful message.
  console.warn(
    '[FactoryERP] Supabase env not configured. Set EXPO_PUBLIC_SUPABASE_URL and ' +
      'EXPO_PUBLIC_SUPABASE_ANON_KEY in .env, then restart with `npx expo start -c`.'
  );
}

// When unconfigured, fall back to a syntactically valid placeholder so
// createClient doesn't throw at import time — the login screen then shows a
// setup hint instead of the app crashing.
export const supabase = createClient(
  isSupabaseConfigured ? (supabaseUrl as string) : 'https://placeholder.supabase.co',
  isSupabaseConfigured ? (supabaseAnonKey as string) : 'public-anon-placeholder',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // React Native has no URL to parse
    },
  }
);
