/**
 * Accountant — per-worker ledger entries for the current payroll period.
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
import { useRoute } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { StatusPill } from '../../components/ui/StatusPill';
import { attachPaymentProof, workerLedgerEntries } from '../../api/endpoints/shifts';
import { uploadPaymentProof } from '../../api/endpoints/shiftPhotos';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES, ROLES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  fontFamily,
  radius,
} from '../../constants/theme';

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function WorkerLedgerScreen() {
  const route = useRoute<any>();
  const queryClient = useQueryClient();
  const { role, factory, enabledModules } = useAuth();
  const workerId: string = route.params?.workerId;
  const workerName: string = route.params?.workerName ?? 'Worker';
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);
  const factoryId = factory?.id ?? '';
  const isAccountant = role === ROLES.ACCOUNTANT || role === ROLES.COMPANY_ADMIN;

  const [uploadingProof, setUploadingProof] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['workerLedger', workerId],
    queryFn: () => workerLedgerEntries(workerId),
    enabled: moduleOn && !!workerId,
  });

  const proofMutation = useMutation({
    mutationFn: async (localUri: string) => {
      if (!factoryId || !workerId) throw new Error('Missing factory or worker ID');
      const finalizedEntries = (data ?? []).filter((r) => r.status === 'finalized');
      if (finalizedEntries.length === 0) {
        throw new Error('No finalized entries to attach proof to.');
      }
      const storagePath = await uploadPaymentProof(factoryId, workerId, localUri);
      const ledgerIds = finalizedEntries.map((r) => r.id);
      return attachPaymentProof(ledgerIds, storagePath);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workerLedger', workerId] });
      queryClient.invalidateQueries({ queryKey: ['salaryRun'] });
    },
    onError: (e) => setProofError(describeDbError(e, 'Payment proof')),
  });

  async function handlePickProof() {
    setProofError(null);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setProofError('Photo library permission is required to attach proof.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;

      setUploadingProof(true);
      await proofMutation.mutateAsync(result.assets[0].uri);
    } catch (e: any) {
      setProofError(describeDbError(e, 'Payment proof'));
    } finally {
      setUploadingProof(false);
    }
  }

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const rows = data ?? [];
  const totalNet = rows.reduce((s, r) => s + Number(r.net), 0);
  const totalStitches = rows.reduce((s, r) => s + Number(r.stitch_count), 0);
  const period = rows[0]?.period ?? '—';
  const finalizedRows = rows.filter((r) => r.status === 'finalized');
  const hasProof = finalizedRows.some((r) => !!r.payment_proof_url);

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.worker}>{workerName}</Text>
            <Text style={styles.period}>Period {period}</Text>
            <View style={styles.totals}>
              <Text style={styles.totalLine}>
                {totalStitches.toLocaleString()} stitches · Net {money(totalNet)}
              </Text>
            </View>

            {isAccountant && finalizedRows.length > 0 ? (
              <View style={styles.proofCard}>
                <Text style={styles.proofTitle}>Payment proof</Text>
                <Text style={styles.proofStatus}>
                  {hasProof ? 'Proof attached for finalized entries.' : 'No proof attached yet.'}
                </Text>
                {proofError ? <Text style={styles.error}>{proofError}</Text> : null}
                <AppButton
                  title={hasProof ? 'Replace payment proof' : 'Upload payment proof'}
                  onPress={handlePickProof}
                  loading={uploadingProof || proofMutation.isPending}
                  variant="secondary"
                  style={{ marginTop: spacing.xs }}
                />
              </View>
            ) : null}

            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? (
              <Text style={styles.error}>{describeDbError(error, 'Ledger')}</Text>
            ) : null}
            {rows.length > 0 ? <Text style={styles.section}>Shift entries</Text> : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyBody}>No ledger entries for this worker in the current period.</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={styles.stitches}>{item.stitch_count.toLocaleString()} st</Text>
              <StatusPill
                label={item.status === 'pending' ? 'Pending' : 'Finalized'}
                color={item.status === 'pending' ? colors.warning : colors.success}
              />
            </View>
            <Text style={styles.meta}>
              Base {money(Number(item.base_per_stitch) * item.stitch_count)}
              {Number(item.bonus) > 0 ? ` · Bonus ${money(Number(item.bonus))}` : ''}
              {Number(item.damage_deduction) > 0
                ? ` · Deduction −${money(Number(item.damage_deduction))}`
                : ''}
            </Text>
            <Text style={styles.net}>Net {money(Number(item.net))}</Text>
            <Text style={styles.date}>
              {formatDate(item.created_at)}
              {item.payment_proof_url ? ' · Proof attached' : ''}
            </Text>
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { padding: spacing.lg, gap: spacing.sm },
  worker: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  period: { fontSize: fontSize.caption, color: colors.slate, textTransform: 'uppercase' },
  totals: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing.md,
  },
  totalLine: {
    fontSize: fontSize.body,
    fontFamily: fontFamily.mono,
    color: colors.indigoDeep,
    fontWeight: fontWeight.medium,
  },
  proofCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  proofTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    textTransform: 'uppercase',
  },
  proofStatus: {
    fontSize: fontSize.secondary,
    color: colors.slate,
  },
  section: {
    marginTop: spacing.md,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
  },
  error: { color: colors.alert, fontSize: fontSize.secondary },
  disabled: { fontSize: fontSize.body, color: colors.slate, textAlign: 'center', padding: spacing.lg },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 2,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stitches: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  net: {
    fontSize: fontSize.secondary,
    fontFamily: fontFamily.mono,
    color: colors.brass,
    fontWeight: fontWeight.medium,
  },
  date: { fontSize: fontSize.caption, color: colors.slate },
});
