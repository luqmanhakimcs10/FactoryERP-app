/**
 * Super Admin — factory detail with billing, modules summary, account toggle,
 * and a read-only inventory tab.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  Image,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { ListRow } from '../../components/lists/ListRow';
import {
  saFactoryList,
  saFactoryModules,
  saFactoryInventory,
  saLastAudit,
  saSetAccountStatus,
} from '../../api/endpoints/factories';
import { describeDbError } from '../../utils/errors';
import { MODULE_LABEL } from '../../constants/roles';
import {
  formatMoney,
  formatDate,
  subscriptionPill,
  accountPill,
} from './FactoryListScreen';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

type Tab = 'details' | 'inventory';

export function FactoryDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const factoryId: string = route.params?.factoryId;
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('details');
  const [togglingAccount, setTogglingAccount] = useState(false);

  const { data: factories, isLoading: listLoading } = useQuery({
    queryKey: ['saFactoryList'],
    queryFn: saFactoryList,
  });
  const factory = factories?.find((f) => f.id === factoryId);

  const { data: modules } = useQuery({
    queryKey: ['saFactoryModules', factoryId],
    queryFn: () => saFactoryModules(factoryId),
    enabled: !!factoryId,
  });

  const { data: inventory, isLoading: invLoading } = useQuery({
    queryKey: ['saFactoryInventory', factoryId],
    queryFn: () => saFactoryInventory(factoryId),
    enabled: !!factoryId && tab === 'inventory',
  });

  const { data: lastAudit } = useQuery({
    queryKey: ['saLastAudit', factoryId],
    queryFn: () => saLastAudit(factoryId),
    enabled: !!factoryId && tab === 'inventory',
  });

  async function onToggleAccount() {
    if (!factory) return;
    const nextActive = factory.account_status !== 'active';
    const action = nextActive ? 'reactivate' : 'deactivate';

    Alert.alert(
      nextActive ? 'Reactivate factory?' : 'Deactivate factory?',
      nextActive
        ? 'Users of this factory will be able to sign in again.'
        : 'All users of this factory will be blocked from signing in until reactivated.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: nextActive ? 'Reactivate' : 'Deactivate',
          style: nextActive ? 'default' : 'destructive',
          onPress: async () => {
            setTogglingAccount(true);
            try {
              await saSetAccountStatus(factoryId, nextActive);
              await queryClient.invalidateQueries({ queryKey: ['saFactoryList'] });
            } catch (e: any) {
              Alert.alert('Could not update account', describeDbError(e, 'Factory'));
            } finally {
              setTogglingAccount(false);
            }
          },
        },
      ]
    );
  }

  if (listLoading && !factory) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} />
      </Screen>
    );
  }

  if (!factory) {
    return (
      <Screen>
        <Text style={styles.error}>Factory not found.</Text>
      </Screen>
    );
  }

  const isActive = factory.account_status === 'active';

  return (
    <Screen padded={false}>
      <View style={styles.tabs}>
        <TabButton label="Details" active={tab === 'details'} onPress={() => setTab('details')} />
        <TabButton label="Inventory" active={tab === 'inventory'} onPress={() => setTab('inventory')} />
      </View>

      {tab === 'details' ? (
        <ScrollView contentContainerStyle={styles.detailsScroll}>
          <Section title="Contact">
            <InfoRow label="Representative" value={factory.representative_name ?? '—'} />
            <InfoRow label="Phone" value={factory.phone ?? '—'} />
            <InfoRow label="Address" value={factory.address ?? '—'} />
          </Section>

          <Section title="Billing">
            <View style={styles.billingHero}>
              <Text style={styles.billingLabel}>Upcoming income</Text>
              <Text style={styles.billingAmount}>{formatMoney(factory.subscription_amount)}</Text>
              <Text style={styles.billingDate}>
                {factory.next_billing_date
                  ? `Due ${formatDate(factory.next_billing_date)}`
                  : 'No billing date set'}
              </Text>
            </View>
            <View style={styles.pillRow}>
              {subscriptionPill(factory.subscription_status)}
              {accountPill(factory.account_status)}
            </View>
          </Section>

          <Section title="Account status">
            <Text style={styles.accountHint}>
              {isActive
                ? 'This factory is active. Users can sign in normally.'
                : 'This factory is inactive. All users are blocked from signing in.'}
            </Text>
            <AppButton
              title={isActive ? 'Set inactive' : 'Set active'}
              variant="brass"
              onPress={onToggleAccount}
              loading={togglingAccount}
              style={styles.toggleBtn}
            />
          </Section>

          <Section title="Modules">
            <View style={styles.moduleSummary}>
              {(modules ?? []).filter((m) => m.enabled).length ? (
                (modules ?? [])
                  .filter((m) => m.enabled)
                  .map((m) => (
                    <View key={m.module_id} style={styles.moduleChip}>
                      <Text style={styles.moduleChipText}>{MODULE_LABEL[m.key] ?? m.name}</Text>
                    </View>
                  ))
              ) : (
                <Text style={styles.muted}>No modules enabled</Text>
              )}
            </View>
            <ListRow
              title="Module toggle"
              subtitle="Enable or disable modules for this factory"
              onPress={() => navigation.navigate('ModuleToggle', { factoryId })}
            />
          </Section>

          <View style={styles.meta}>
            <Text style={styles.metaText}>
              Code prefix {factory.code_prefix} · {factory.user_count} users · Created{' '}
              {formatDate(factory.created_at)}
            </Text>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={inventory ?? []}
          keyExtractor={(row) => row.id}
          ListHeaderComponent={
            <View style={styles.auditBanner}>
              <Text style={styles.auditLabel}>Last stock audit</Text>
              {lastAudit === undefined && invLoading ? (
                <ActivityIndicator color={colors.indigo} size="small" />
              ) : lastAudit ? (
                <Text style={styles.auditDate}>
                  {new Date(lastAudit).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </Text>
              ) : (
                <Text style={styles.auditEmpty}>No audit yet</Text>
              )}
            </View>
          }
          ListEmptyComponent={
            !invLoading ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No thread stock</Text>
                <Text style={styles.emptyBody}>This factory has no colour stock recorded yet.</Text>
              </View>
            ) : (
              <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
            )
          }
          renderItem={({ item }) => (
            <View style={styles.invRow}>
              {item.photo_url ? (
                <Image source={{ uri: item.photo_url }} style={styles.thumb} />
              ) : (
                <View style={[styles.thumb, styles.thumbPlaceholder]}>
                  <Text style={styles.thumbPlaceholderText}>—</Text>
                </View>
              )}
              <View style={styles.invBody}>
                <Text style={styles.colorName}>{item.color_name ?? item.color_code}</Text>
                <Text style={styles.colorCode}>{item.color_code}</Text>
              </View>
              <Text style={styles.qty}>{Number(item.quantity_meters).toLocaleString()} m</Text>
            </View>
          )}
        />
      )}
    </Screen>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      style={[styles.tabBtn, active && styles.tabBtnActive]}
    >
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabBtnActive: { borderBottomColor: colors.brass },
  tabLabel: { fontSize: fontSize.secondary, fontWeight: fontWeight.medium, color: colors.slate },
  tabLabelActive: { color: colors.indigoDeep },
  detailsScroll: { paddingBottom: spacing.xxl },
  section: { marginTop: spacing.lg },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  sectionBody: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  infoRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoLabel: { fontSize: fontSize.caption, color: colors.slate },
  infoValue: { marginTop: 2, fontSize: fontSize.body, color: colors.indigoDeep },
  billingHero: {
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  billingLabel: { fontSize: fontSize.caption, color: colors.slate, textTransform: 'uppercase' },
  billingAmount: {
    marginTop: spacing.xs,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    fontFamily: fontFamily.mono,
  },
  billingDate: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  pillRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  accountHint: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.slate,
    lineHeight: 20,
  },
  toggleBtn: { margin: spacing.lg },
  moduleSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  moduleChip: {
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  moduleChipText: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  muted: { fontSize: fontSize.secondary, color: colors.slate },
  meta: { padding: spacing.lg },
  metaText: { fontSize: fontSize.caption, color: colors.slate },
  auditBanner: {
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.xs,
  },
  auditLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  auditDate: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  auditEmpty: { fontSize: fontSize.body, color: colors.slate, fontStyle: 'italic' },
  invRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  thumb: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.border },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbPlaceholderText: { color: colors.slate, fontSize: fontSize.caption },
  invBody: { flex: 1 },
  colorName: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  colorCode: {
    marginTop: 2,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.secondary,
    color: colors.slate,
  },
  qty: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    color: colors.indigoDeep,
  },
  empty: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
  error: { fontSize: fontSize.secondary, color: colors.alert },
});
