/**
 * Profiles API — the only module that reads/writes the profiles table.
 * RLS on the DB is the real guard; this layer just keeps access consistent.
 */
import { supabase } from '../client';
import type { Profile } from '../../models/types';

/** Fetch the signed-in user's own profile (role + factory_id). */
export async function getMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return (data as Profile) ?? null;
}

/**
 * The caller's own granted permission add-ons.
 * RLS lets a user read their own grants, so this needs no elevated rights.
 */
export async function getMyPermissions(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('user_permissions')
    .select('permission_key')
    .eq('user_id', userId);

  // A missing grant table or a denied read must not block login — the user
  // simply has no add-ons beyond their base role.
  if (error) return [];
  return (data ?? []).map((r: any) => r.permission_key as string);
}
