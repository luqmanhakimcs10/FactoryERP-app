/**
 * Super Admin — factory list landing screen.
 * Lists all factories with billing summary; entry point to detail and create.
 */
import React from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { ListRow } from '../../components/lists/ListRow';
import { StatusPill } from '../../components/ui/StatusPill';
import { saFactoryList } from '../../api/endpoints/factories';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
} from '../../constants/theme';
import type { SaFactoryListRow } from '../../models/types';

function subscriptionPill(status: SaFactoryListRow['subscription_status']) {
  return (
    <StatusPill
      label={status === 'paid' ? 'Paid' : 'Unpaid'}
      color={status === 'paid' ? colors.success : colors.warning}
    />
  );
}

function accountPill(status: SaFactoryListRow['account_status']) {
  return (
    <StatusPill
      label={status === 'active' ? 'Active' : 'Inactive'}
      color={status === 'active' ? colors.success : colors.slate}
    />
  );
}

function formatMoney(amount: number): string {
  return `Rs ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function FactoryListScreen() {
  const navigation = useNavigation<any>();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['saFactoryList'],
    queryFn: saFactoryList,
  });

  const unpaid = (data ?? []).filter((f) => f.subscription_status === 'unpaid').length;

  return (
    <Screen padded={false}>
      <DashboardHeader navigation={navigation} />

      {/* Unpaid subscriptions are the only thing on this screen that needs the
          platform admin to DO something. Read from the list already loaded. */}
      {unpaid > 0 ? (
        <ActionBanner
          title={`${unpaid} factor${unpaid === 1 ? 'y has' : 'ies have'} an unpaid subscription`}
          subtitle="Review billing before the next cycle"
          style={styles.banner}
        />
      ) : null}
      <FlatList
        data={data ?? []}
        keyExtractor={(f) => f.id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.lede}>
              Manage factory accounts, billing, and read-only inventory visibility.
            </Text>
            <AppButton
              title="Add factory"
              variant="brass"
              onPress={() => navigation.navigate('NewFactory')}
              style={styles.addBtn}
            />
            {isLoading ? <ActivityIndicator color={colors.indigo} style={styles.loader} /> : null}
            {isError ? (
              <Text style={styles.error}>{describeDbError(error, 'Factory list')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No factories yet</Text>
              <Text style={styles.emptyBody}>Create the first factory to get started.</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.name}
            subtitle={`${item.active_modules} modules · ${item.user_count} users`}
            caption={
              item.next_billing_date
                ? `Next billing ${formatDate(item.next_billing_date)} · ${formatMoney(item.subscription_amount)}`
                : `${formatMoney(item.subscription_amount)} / cycle`
            }
            rightNode={
              <View style={styles.pills}>
                {subscriptionPill(item.subscription_status)}
                {accountPill(item.account_status)}
              </View>
            }
            onPress={() => navigation.navigate('FactoryDetail', { factoryId: item.id })}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  header: { padding: spacing.lg, gap: spacing.md },
  lede: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  addBtn: { alignSelf: 'flex-start' },
  loader: { marginTop: spacing.sm },
  error: { fontSize: fontSize.secondary, color: colors.alert },
  pills: { gap: spacing.xs, alignItems: 'flex-end' },
  empty: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});

export { formatMoney, formatDate, subscriptionPill, accountPill };
