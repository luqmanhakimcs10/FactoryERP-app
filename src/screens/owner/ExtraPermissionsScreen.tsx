/**
 * Extra Permissions — per-user add-ons on top of a base role.
 *
 * Depends on the permission utility understanding add-ons at all. It did not
 * before Phase 7 (canAccessRole only checked base role), so `canAccess()` and
 * AuthContext's `permissions` were added first; this screen writes what they read.
 *
 * Add-ons only ever ADD capability. They cannot remove what a role already
 * allows, and — importantly — granting a key does not widen any RLS policy:
 * the database still decides, so a grant can never become a privilege hole.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { StitchLine } from '../../components/ui/StitchLine';
import {
  listUserPermissions,
  grantPermission,
  revokePermission,
} from '../../api/endpoints/finance';
import { supabase } from '../../api/client';
import { ALL_PERMISSION_KEYS, PERMISSION_LABEL, type PermissionKey } from '../../utils/permissions';
import { ROLE_LABEL, type Role } from '../../constants/roles';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
} from '../../constants/theme';

export function ExtraPermissionsScreen() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ['factoryProfiles'],
    queryFn: async () => {
      const { data, error: e } = await supabase
        .from('profiles')
        .select('id, display_name, role')
        .order('display_name');
      if (e) throw e;
      return (data ?? []) as { id: string; display_name: string; role: Role }[];
    },
  });

  const { data: grants } = useQuery({
    queryKey: ['userPermissions'],
    queryFn: listUserPermissions,
  });

  const toggle = useMutation({
    mutationFn: async (args: { userId: string; key: PermissionKey; on: boolean }) =>
      args.on ? grantPermission(args.userId, args.key) : revokePermission(args.userId, args.key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['userPermissions'] }),
    onError: (e) => setError(describeDbError(e, 'Permission')),
  });

  const filtered = (users ?? []).filter(
    (u) => !search.trim() || u.display_name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const grantsFor = (userId: string) =>
    (grants ?? []).filter((g) => g.user_id === userId).map((g) => g.permission_key);

  if (isLoading) {
    return <Screen><ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} /></Screen>;
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        ListHeaderComponent={
          <View>
            <Text style={styles.intro}>
              Grant a user capability beyond their role. Add-ons never remove what
              a role already allows, and the database still enforces every rule.
            </Text>
            <View style={styles.stitch}><StitchLine /></View>
            <SearchBar value={search} onChangeText={setSearch} placeholder="Search people" />
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.center}><Text style={styles.emptyTitle}>No users match</Text></View>
        }
        renderItem={({ item }) => {
          const open = selected === item.id;
          const held = grantsFor(item.id);
          return (
            <View style={styles.userBlock}>
              <Pressable
                onPress={() => setSelected(open ? null : item.id)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                style={({ pressed }) => [styles.userRow, pressed && { backgroundColor: colors.pressed }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.userName}>{item.display_name}</Text>
                  <Text style={styles.userMeta}>
                    {ROLE_LABEL[item.role] ?? item.role}
                    {held.length ? ` · ${held.length} add-on${held.length === 1 ? '' : 's'}` : ''}
                  </Text>
                </View>
                <Text style={styles.chevron}>{open ? '−' : '+'}</Text>
              </Pressable>

              {open ? (
                <View style={styles.keys}>
                  {ALL_PERMISSION_KEYS.map((k) => {
                    const on = held.includes(k);
                    return (
                      <Pressable
                        key={k}
                        onPress={() => {
                          setError(null);
                          toggle.mutate({ userId: item.id, key: k, on: !on });
                        }}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                        {...(Platform.OS === 'web' ? ({ 'aria-checked': on } as object) : {})}
                        style={({ pressed }) => [styles.key, on && styles.keyOn, pressed && { opacity: 0.7 }]}
                      >
                        <Text style={[styles.keyText, on && styles.keyTextOn]}>
                          {PERMISSION_LABEL[k]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { padding: spacing.lg, paddingBottom: 0, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  stitch: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  userBlock: { borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  userRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  userName: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  userMeta: { fontSize: fontSize.caption, color: colors.slate },
  chevron: { fontSize: 22, color: colors.slate, width: 20, textAlign: 'center' },
  keys: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.lg, paddingTop: 0 },
  key: {
    minHeight: 40, justifyContent: 'center', paddingHorizontal: spacing.md,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.canvas,
  },
  keyOn: { backgroundColor: colors.brass, borderColor: colors.brass },
  keyText: { fontSize: fontSize.caption, color: colors.slate, fontWeight: fontWeight.medium },
  keyTextOn: { color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  error: { paddingHorizontal: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
  center: { padding: spacing.xl, alignItems: 'center' },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
});
