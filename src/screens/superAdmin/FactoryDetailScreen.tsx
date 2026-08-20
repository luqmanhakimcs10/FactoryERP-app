/**
 * Super Admin — "View details" from a factory row's ⋮ menu.
 *
 * Read-only company details: the contact block, the subscription terms, and the
 * modules currently enabled. Everything that CHANGES a factory now lives on the
 * menu that opened this screen (Edit, Set active/inactive, Payment history), so
 * this screen has no controls of its own — it answers "who is this factory",
 * nothing more.
 *
 * The read-only inventory tab that used to sit beside these details is gone.
 * Super Admin has no access to a factory's stock in any form.
 */
import React from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { saFactoryList, saFactoryModules } from '../../api/endpoints/factories';
import { MODULE_LABEL } from '../../constants/roles';
import { formatMoney, formatDate, subscriptionPill, accountPill } from './parts';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export function FactoryDetailScreen() {
  const route = useRoute<any>();
  const factoryId: string = route.params?.factoryId;

  const { data: factories, isLoading } = useQuery({
    queryKey: ['saFactoryList'],
    queryFn: saFactoryList,
  });
  const factory = factories?.find((f) => f.id === factoryId);

  const { data: modules } = useQuery({
    queryKey: ['saFactoryModules', factoryId],
    queryFn: () => saFactoryModules(factoryId),
    enabled: !!factoryId,
  });

  if (isLoading && !factory) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} />
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

  const enabled = (modules ?? []).filter((m) => m.enabled);

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <Text style={styles.heroName}>{factory.name}</Text>
          <View style={styles.pillRow}>
            {subscriptionPill(factory.subscription_status)}
            {accountPill(factory.account_status)}
          </View>
        </View>

        <Section title="Company">
          <InfoRow label="Representative" value={factory.representative_name ?? '—'} />
          <InfoRow label="Phone" value={factory.phone ?? '—'} />
          <InfoRow label="Address" value={factory.address ?? '—'} />
          <InfoRow label="Code prefix" value={factory.code_prefix} mono />
        </Section>

        <Section title="Subscription">
          <InfoRow label="Amount per cycle" value={formatMoney(factory.subscription_amount)} mono />
          <InfoRow
            label="Next billing date"
            value={factory.next_billing_date ? formatDate(factory.next_billing_date) : 'Not set'}
          />
          <InfoRow
            label="Status"
            value={factory.subscription_status === 'paid' ? 'Paid' : 'Unpaid'}
          />
        </Section>

        <Section title="Modules">
          <View style={styles.moduleSummary}>
            {enabled.length ? (
              enabled.map((m) => (
                <View key={m.module_id} style={styles.moduleChip}>
                  <Text style={styles.moduleChipText}>{MODULE_LABEL[m.key] ?? m.name}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.muted}>No modules enabled</Text>
            )}
          </View>
          <Text style={styles.hint}>
            Modules are switched on the Modules tab.
          </Text>
        </Section>

        <View style={styles.meta}>
          <Text style={styles.metaText}>
            {factory.user_count} user{factory.user_count === 1 ? '' : 's'} · Created{' '}
            {formatDate(factory.created_at)}
          </Text>
        </View>
      </ScrollView>
    </Screen>
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

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && { fontFamily: fontFamily.mono }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  hero: { padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.surface },
  heroName: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  pillRow: { flexDirection: 'row', gap: spacing.sm },
  section: { marginTop: spacing.lg },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
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
  infoLabel: { fontSize: fontSize.caption, color: colors.inkMuted },
  infoValue: { marginTop: 2, fontSize: fontSize.body, color: colors.ink },
  moduleSummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  moduleChip: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  moduleChipText: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  muted: { fontSize: fontSize.secondary, color: colors.inkMuted },
  hint: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    fontSize: fontSize.caption,
    color: colors.inkSubtle,
  },
  meta: { padding: spacing.lg },
  metaText: { fontSize: fontSize.caption, color: colors.inkMuted },
  error: { fontSize: fontSize.secondary, color: colors.alert },
});
