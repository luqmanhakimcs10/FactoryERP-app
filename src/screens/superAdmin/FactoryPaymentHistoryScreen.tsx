/**
 * Super Admin — "Payment history" from a factory row's ⋮ menu.
 *
 * One factory's billing ledger: every invoice raised against it, settled or
 * not, newest first. The header totals what is still outstanding, because that
 * is the figure the platform admin opened this screen to find.
 *
 * "Raise next invoice" is here rather than on the dashboard: raising a cycle is
 * a decision about ONE factory, and this is the only screen that shows what
 * that factory has already been billed.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { saInvoiceList, saIssueInvoice } from '../../api/endpoints/factories';
import { describeDbError } from '../../utils/errors';
import { formatMoney } from './parts';
import { InvoiceCard } from './SuperAdminHomeScreen';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

export function FactoryPaymentHistoryScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const factoryId: string = route.params?.factoryId;
  const factoryName: string = route.params?.factoryName ?? 'Factory';

  const [confirmIssue, setConfirmIssue] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invoices = useQuery({
    queryKey: ['saInvoices', 'factory', factoryId],
    queryFn: () => saInvoiceList({ factoryId }),
    enabled: !!factoryId,
  });

  const rows = invoices.data ?? [];
  const totals = useMemo(
    () => ({
      outstanding: rows
        .filter((i) => i.status === 'pending')
        .reduce((sum, i) => sum + Number(i.amount), 0),
      paid: rows
        .filter((i) => i.status === 'paid')
        .reduce((sum, i) => sum + Number(i.amount), 0),
    }),
    [rows]
  );

  async function issue() {
    setIssuing(true);
    setError(null);
    try {
      await saIssueInvoice({ factoryId });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['saInvoices'] }),
        queryClient.invalidateQueries({ queryKey: ['saBillingSummary'] }),
        queryClient.invalidateQueries({ queryKey: ['saFactoryList'] }),
      ]);
      setConfirmIssue(false);
    } catch (e: any) {
      setError(describeDbError(e, 'Invoice'));
    } finally {
      setIssuing(false);
    }
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={invoices.isRefetching}
            onRefresh={invoices.refetch}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.summary}>
              <Text style={styles.summaryLabel}>Outstanding · {factoryName}</Text>
              <Text style={styles.summaryAmount}>{formatMoney(totals.outstanding)}</Text>
              <Text style={styles.summaryMeta}>
                {formatMoney(totals.paid)} settled across {rows.length} invoice
                {rows.length === 1 ? '' : 's'}
              </Text>
            </View>

            <AppButton
              title="Raise next invoice"
              variant="secondary"
              size="sm"
              onPress={() => setConfirmIssue(true)}
              style={styles.issueBtn}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {invoices.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
            {invoices.isError ? (
              <Text style={styles.error}>{describeDbError(invoices.error, 'Payment history')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !invoices.isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No invoices yet</Text>
              <Text style={styles.emptyBody}>
                Raise the first cycle to start this factory's billing record.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => <InvoiceCard invoice={item} />}
      />

      <ConfirmDialog
        visible={confirmIssue}
        title="Raise the next invoice?"
        message={`A new pending invoice will be raised against ${factoryName} at its current subscription amount. Its Paid pill becomes Unpaid until the invoice is settled.`}
        confirmLabel="Raise invoice"
        loading={issuing}
        onConfirm={issue}
        onCancel={() => {
          setConfirmIssue(false);
          setError(null);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  summary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  summaryLabel: {
    fontSize: fontSize.caption,
    color: colors.inkMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summaryAmount: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  summaryMeta: { fontSize: fontSize.caption, color: colors.inkMuted },
  issueBtn: { alignSelf: 'flex-start', marginBottom: spacing.md },
  error: { marginBottom: spacing.sm, fontSize: fontSize.secondary, color: colors.alert },
  empty: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.ink },
  emptyBody: { fontSize: fontSize.secondary, color: colors.inkMuted, textAlign: 'center' },
});
