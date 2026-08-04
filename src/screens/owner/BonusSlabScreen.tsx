/**
 * Owner — daily stitch bonus slab configuration.
 *
 * Slabs are evaluated at shift-close posting time against the worker's
 * cumulative daily stitch total. Managed via RPC, not generic masters.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Platform,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { ListRow } from '../../components/lists/ListRow';
import { deleteBonusSlab, listBonusSlabs, upsertBonusSlab } from '../../api/endpoints/shifts';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import type { BonusSlab } from '../../models/shiftTypes';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  fontFamily,
  radius,
} from '../../constants/theme';

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onConfirm },
  ]);
}

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function BonusSlabScreen() {
  const queryClient = useQueryClient();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);

  const [editing, setEditing] = useState<BonusSlab | null>(null);
  const [threshold, setThreshold] = useState('');
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['bonusSlabs'],
    queryFn: listBonusSlabs,
    enabled: moduleOn,
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const dailyStitchThreshold = parseInt(threshold, 10);
      const bonusAmount = parseFloat(amount);
      if (!Number.isFinite(dailyStitchThreshold) || dailyStitchThreshold <= 0) {
        throw new Error('Enter a valid daily stitch threshold.');
      }
      if (!Number.isFinite(bonusAmount) || bonusAmount <= 0) {
        throw new Error('Enter a valid bonus amount.');
      }
      return upsertBonusSlab({
        id: editing?.id,
        dailyStitchThreshold,
        bonusAmount,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bonusSlabs'] });
      resetForm();
    },
    onError: (e) => setFormError(describeDbError(e, 'Bonus slab')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBonusSlab(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bonusSlabs'] });
      if (editing) resetForm();
    },
    onError: (e) => setFormError(describeDbError(e, 'Bonus slab')),
  });

  function resetForm() {
    setEditing(null);
    setThreshold('');
    setAmount('');
    setFormError(null);
  }

  function startEdit(slab: BonusSlab) {
    setEditing(slab);
    setThreshold(String(slab.daily_stitch_threshold));
    setAmount(String(slab.bonus_amount));
    setFormError(null);
  }

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const rows = data ?? [];

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(s) => s.id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.hint}>
              Workers earn the highest slab reached for the day. Bonus is incremental — only the
              delta above prior shifts that day is posted.
            </Text>

            <View style={styles.form}>
              <Text style={styles.formTitle}>{editing ? 'Edit slab' : 'Add slab'}</Text>
              <TextField
                label="Daily stitch threshold"
                value={threshold}
                onChangeText={setThreshold}
                numeric
                mono
                required
              />
              <TextField
                label="Bonus amount"
                value={amount}
                onChangeText={setAmount}
                numeric
                mono
                required
              />
              {formError ? <Text style={styles.error}>{formError}</Text> : null}
              <AppButton
                title={editing ? 'Save changes' : 'Add slab'}
                onPress={() => saveMutation.mutate()}
                loading={saveMutation.isPending}
                variant="brass"
              />
              {editing ? (
                <>
                  <AppButton title="Cancel edit" onPress={resetForm} variant="secondary" />
                  <AppButton
                    title="Delete slab"
                    onPress={() =>
                      confirmAction(
                        'Delete bonus slab?',
                        `Remove the ${editing.daily_stitch_threshold.toLocaleString()} stitch slab?`,
                        () => deleteMutation.mutate(editing.id)
                      )
                    }
                    variant="secondary"
                    loading={deleteMutation.isPending}
                  />
                </>
              ) : null}
            </View>

            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? (
              <Text style={styles.error}>{describeDbError(error, 'Bonus slab')}</Text>
            ) : null}
            {rows.length > 0 ? <Text style={styles.section}>Configured slabs</Text> : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyBody}>
                No bonus slabs yet. Add thresholds to reward high daily output.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ListRow
            title={`${item.daily_stitch_threshold.toLocaleString()} stitches / day`}
            subtitle={`Bonus ${money(Number(item.bonus_amount))}`}
            onPress={() => startEdit(item)}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { padding: spacing.lg, gap: spacing.sm },
  hint: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 22 },
  form: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  formTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  section: {
    marginTop: spacing.lg,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
  },
  error: { color: colors.alert, fontSize: fontSize.secondary },
  disabled: { fontSize: fontSize.body, color: colors.slate, textAlign: 'center', padding: spacing.lg },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
