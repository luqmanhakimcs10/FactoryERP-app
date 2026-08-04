/**
 * Employees — the Owner's staff list.
 *
 * Lists every profile in the factory with its compensation record (added by the
 * role-first Add Employee flow). Search, an inline add control, and an expand
 * action to deactivate a login (profiles are soft-toggled via is_active, never
 * hard-deleted, so history and shift references stay intact).
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { StitchLine } from '../../components/ui/StitchLine';
import { AppButton } from '../../components/ui/AppButton';
import { listEmployees, deactivateEmployee } from '../../api/endpoints/employees';
import { ROLE_LABEL, type Role } from '../../constants/roles';
import { SALARY_TYPE_LABEL } from '../../models/types';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

const money = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Deactivate', style: 'destructive', onPress: onConfirm },
  ]);
}

export function EmployeeManagementScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['employees'],
    queryFn: listEmployees,
  });

  const deactivate = useMutation({
    mutationFn: (userId: string) => deactivateEmployee(userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['salaryRun'] });
    },
    onError: (e) => setError(describeDbError(e, 'Employee')),
  });

  const filtered = (data ?? []).filter(
    (e) =>
      !search.trim() ||
      e.display_name.toLowerCase().includes(search.trim().toLowerCase()) ||
      ROLE_LABEL[e.role]?.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <Screen padded={false}>
      <FlatList
        data={filtered}
        keyExtractor={(e) => e.id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            <Text style={styles.intro}>
              Everyone with a login at this factory, and how they're paid. Add staff
              with the button below — the employee gets their login and appears in
              the Salary Run by pay type.
            </Text>
            <View style={styles.stitch}>
              <StitchLine />
            </View>
            <View style={styles.toolbar}>
              <View style={styles.searchWrap}>
                <SearchBar value={search} onChangeText={setSearch} placeholder="Search staff" />
              </View>
              <Pressable
                onPress={() => navigation.navigate('AddEmployee')}
                accessibilityRole="button"
                style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
              >
                <Text style={styles.addBtnText}>+ Add</Text>
              </Pressable>
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
          ) : isError ? (
            <Text style={styles.emptyBody}>Couldn't load employees.</Text>
          ) : (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No employees yet</Text>
              <Text style={styles.emptyBody}>Tap "+ Add" to create the first one.</Text>
            </View>
          )
        }
        renderItem={({ item }) => {
          const comp = item.employee_compensation;
          const open = selected === item.id;
          const active = item.is_active;
          return (
            <View style={styles.userBlock}>
              <Pressable
                onPress={() => setSelected(open ? null : item.id)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                style={({ pressed }) => [styles.userRow, pressed && styles.pressedRow]}
              >
                <View style={styles.userBody}>
                  <Text style={styles.userName}>{item.display_name}</Text>
                  <Text style={styles.userMeta}>
                    {ROLE_LABEL[item.role as Role] ?? item.role}
                    {comp ? (
                      <>
                        {' · '}
                        <Text style={styles.mono}>
                          {SALARY_TYPE_LABEL[comp.salary_type]} · {money(comp.salary_amount)}
                        </Text>
                      </>
                    ) : null}
                  </Text>
                </View>
                <View
                  style={[
                    styles.pill,
                    { backgroundColor: active ? colors.success : colors.slate },
                  ]}
                >
                  <Text style={styles.pillText}>{active ? 'Active' : 'Inactive'}</Text>
                </View>
                <Text style={styles.chevron}>{open ? '−' : '+'}</Text>
              </Pressable>

              {open && active ? (
                <View style={styles.actions}>
                  <AppButton
                    title="Deactivate login"
                    variant="secondary"
                    onPress={() =>
                      confirmAction(
                        `Deactivate ${item.display_name}`,
                        'Their history stays intact, but they can no longer sign in. You can add them again later.',
                        () => {
                          setError(null);
                          deactivate.mutate(item.id);
                        }
                      )
                    }
                    loading={deactivate.isPending}
                  />
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
  intro: {
    padding: spacing.lg,
    paddingBottom: 0,
    fontSize: fontSize.secondary,
    color: colors.slate,
    lineHeight: 20,
  },
  stitch: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  searchWrap: { flex: 1 },
  addBtn: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.brass,
  },
  addBtnText: {
    color: colors.indigoDeep,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
  },
  pressed: { opacity: 0.75 },
  error: { paddingHorizontal: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
  userBlock: { borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  pressedRow: { backgroundColor: colors.pressed },
  userBody: { flex: 1 },
  userName: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  userMeta: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill },
  pillText: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  chevron: { fontSize: 22, color: colors.slate, width: 20, textAlign: 'center' },
  actions: { padding: spacing.lg, paddingTop: 0 },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});

export default EmployeeManagementScreen;
