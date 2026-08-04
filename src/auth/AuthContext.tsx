/**
 * AuthContext — single source of truth for "who is logged in".
 * Holds the Supabase session + the user's profile (role + factory_id) + the
 * factory record + enabled module keys. Handles login, logout, and session
 * restoration on app launch.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  signInWithPassword,
  signOut as apiSignOut,
  getSession,
  onAuthStateChange,
} from '../api/endpoints/auth';
import { getMyProfile, getMyPermissions } from '../api/endpoints/profiles';
import { getMyFactory, getEnabledModuleKeys, isMyFactoryActive } from '../api/endpoints/factories';
import { useQueryClient } from '@tanstack/react-query';
import type { Profile, Factory } from '../models/types';
import type { ModuleKey, Role } from '../constants/roles';

/** Shown when a user's factory account has been deactivated by Super Admin. */
export const FACTORY_INACTIVE_MESSAGE =
  'This factory account is inactive. Contact your platform administrator.';

interface AuthState {
  initializing: boolean; // true while restoring session at launch
  hydrating: boolean; // true while fetching profile after an explicit sign-in
  session: Session | null;
  profile: Profile | null;
  factory: Factory | null;
  enabledModules: ModuleKey[];
  /** Owner-granted add-on keys, on top of the base role. */
  permissions: string[];
  role: Role | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [initializing, setInitializing] = useState(true);
  const [hydrating, setHydrating] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [factory, setFactory] = useState<Factory | null>(null);
  const [enabledModules, setEnabledModules] = useState<ModuleKey[]>([]);
  // Phase 7: per-user permission add-ons granted by the owner, on top of role.
  const [permissions, setPermissions] = useState<string[]>([]);

  function clearAuthState() {
    setProfile(null);
    setFactory(null);
    setEnabledModules([]);
    setPermissions([]);
  }

  /** Load the profile + factory + modules + granted permissions for a user. */
  async function hydrate(sess: Session | null) {
    if (!sess?.user) {
      clearAuthState();
      return;
    }
    const prof = await getMyProfile(sess.user.id);
    setProfile(prof);

    if (!prof) {
      // Signed in but no profile row yet (e.g. not seeded) — nothing to load.
      clearAuthState();
      return;
    }

    if (prof.factory_id) {
      // Tenanted user: load factory, enabled modules, granted permissions.
      const [fac, mods, perms] = await Promise.all([
        getMyFactory(prof.factory_id),
        getEnabledModuleKeys(prof.factory_id),
        // RLS lets a user read their own grants, so this needs no extra rights.
        getMyPermissions(sess.user.id),
      ]);
      setFactory(fac);
      setEnabledModules(mods);
      setPermissions(perms);
    } else {
      // super_admin is cross-tenant: profile has no factory, so factory/modules
      // stay empty but the profile (and therefore the role) must be kept.
      setFactory(null);
      setEnabledModules([]);
      setPermissions([]);
    }
  }

  /** Reject sessions for users whose factory account is inactive (0028). */
  async function assertFactoryActive(sess: Session | null) {
    if (!sess?.user) return;
    const active = await isMyFactoryActive();
    if (!active) {
      await apiSignOut();
      setSession(null);
      clearAuthState();
      queryClient.clear();
      throw new Error(FACTORY_INACTIVE_MESSAGE);
    }
  }

  // Restore session at launch + subscribe to auth changes.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const sess = await getSession();
        if (!active) return;
        setSession(sess);
        await hydrate(sess);
        await assertFactoryActive(sess);
      } catch (e) {
        console.warn('[Auth] session restore failed', e);
      } finally {
        if (active) setInitializing(false);
      }
    })();

    const sub = onAuthStateChange(async (sess) => {
      setSession(sess);
      try {
        await hydrate(sess);
        await assertFactoryActive(sess);
      } catch (e) {
        console.warn('[Auth] hydrate on auth change failed', e);
      }
    });

    return () => {
      active = false;
      sub.unsubscribe();
    };
  }, []);

  async function signIn(email: string, password: string) {
    setHydrating(true);
    try {
      const { session: sess } = await signInWithPassword(email, password);
      setSession(sess);
      await hydrate(sess);
      await assertFactoryActive(sess);
    } finally {
      setHydrating(false);
    }
  }

  async function signOut() {
    await apiSignOut();
    setSession(null);
    clearAuthState();
    // Drop every cached query with the session.
    //
    // React Query's cache is keyed by query name, not by user, so without this
    // the NEXT person to sign in on this device sees the previous user's rows
    // until each query refetches. In a multi-tenant app that is not merely
    // stale UI — a Beta user could be shown Alpha data that RLS would never
    // have returned for them. The server was always right; the client was
    // showing something it should have thrown away.
    queryClient.clear();
  }

  const value = useMemo<AuthState>(
    () => ({
      initializing,
      hydrating,
      session,
      profile,
      factory,
      enabledModules,
      permissions,
      role: (profile?.role as Role) ?? null,
      signIn,
      signOut,
    }),
    [initializing, hydrating, session, profile, factory, enabledModules, permissions]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
