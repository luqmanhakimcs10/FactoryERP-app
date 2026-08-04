/**
 * Finishing Partner Dashboard — the partner's home screen. Read-only by design.
 *
 * Headline is the earnings summary for the selected period. Below it, three
 * tabs: completed work (the repeats that realized earnings), damage charges
 * (deductions), and payment history (what the accountant has settled).
 *
 * Every number comes from partner_ledger via SECURITY DEFINER RPCs scoped to
 * the partner profile linked to the logged-in user — there is no write here.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../../auth/AuthContext';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { StitchLine } from '../../components/ui/StitchLine';
import {
  getPartnerEarningsSummary,
  getPartnerCompletedWork,
  getPartnerDamageCharges,
  getPartnerPaymentHistory,
} from '../../api/endpoints/dashboards';
import { listPartnerActiveWork, markPartnerReady } from '../../api/endpoints/stageHandover';
import { AppButton } from '../../components/ui/AppButton';
import { StatusPill } from '../../components/ui/StatusPill';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

/** YYYY-MM for the month n months before now (UTC). */
function periodFor(monthsBack: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const PERIODS = [periodFor(0), periodFor(1), periodFor(2)];

type Tab = 'active' | 'work' | 'damage' | 'payments';
const TABS: { key: Tab; label: string }[] = [
  // Active work leads: it is the only tab with something to DO on it, and the
  // only one whose contents change while the partner is looking at the screen.
  { key: 'active', label: 'Active work' },
  { key: 'work', label: 'Completed work' },
  { key: 'damage', label: 'Damage charges' },
  { key: 'payments', label: 'Payments' },
];

export function PartnerDashboardScreen() {
  const navigation = useNavigation<any>();
  const { profile } = useAuth();
  const [period, setPeriod] = useState(PERIODS[0]);
  const [tab, setTab] = useState<Tab>('active');

  const summary = useQuery({
    queryKey: ['partner', 'summary', period],
    queryFn: () => getPartnerEarningsSummary(period),
  });
  const work = useQuery({
    queryKey: ['partner', 'work', period],
    queryFn: () => getPartnerCompletedWork(period),
  });
  const damage = useQuery({
    queryKey: ['partner', 'damage', period],
    queryFn: () => getPartnerDamageCharges(period),
  });
  const payments = useQuery({
    queryKey: ['partner', 'payments'],
    queryFn: getPartnerPaymentHistory,
  });
  // Not period-scoped: work currently in the partner's hands is a live fact,
  // not something that belongs to a billing month.
  const activeWork = useQuery({
    queryKey: ['partner', 'activeWork'],
    queryFn: listPartnerActiveWork,
  });

  const onRefresh = () => {
    summary.refetch();
    work.refetch();
    damage.refetch();
    payments.refetch();
    activeWork.refetch();
  };

  const active =
    tab === 'active' ? activeWork
    : tab === 'work' ? work
    : tab === 'damage' ? damage
    : payments;
  const refreshing = summary.isRefetching || active.isRefetching;

  return (
    <Screen padded={false}>
      <DashboardHeader navigation={navigation} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.indigo} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>My Dashboard</Text>
          <Text style={styles.subtitle}>{profile?.display_name ?? 'Finishing partner'}</Text>
        </View>
        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* Work physically in this partner's hands — the only thing on this
            dashboard they can act on. Same query the Active work tab reads. */}
        {activeWork.data && activeWork.data.length > 0 ? (
          <ActionBanner
            title={`${activeWork.data.length} piece${activeWork.data.length === 1 ? '' : 's'} with you now`}
            subtitle="Mark each one finished when your work on it is done"
            onPress={() => setTab('active')}
            style={{ marginBottom: spacing.lg }}
          />
        ) : null}

        <View style={styles.periods}>
          {PERIODS.map((p) => (
            <Pressable
              key={p}
              onPress={() => setPeriod(p)}
              accessibilityRole="radio"
              accessibilityState={{ checked: period === p, selected: period === p }}
              {...(Platform.OS === 'web' ? ({ 'aria-checked': period === p } as object) : {})}
              style={({ pressed }) => [
                styles.period,
                period === p && styles.periodOn,
                pressed && { opacity: 0.75 },
              ]}
            >
              <Text style={[styles.periodText, period === p && styles.periodTextOn]}>{p}</Text>
            </Pressable>
          ))}
        </View>

        <SummaryCard q={summary} period={period} />

        <View style={styles.tabs}>
          {TABS.map((t) => (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              accessibilityRole="radio"
              accessibilityState={{ checked: tab === t.key, selected: tab === t.key }}
              {...(Platform.OS === 'web' ? ({ 'aria-checked': tab === t.key } as object) : {})}
              style={({ pressed }) => [
                styles.tab,
                tab === t.key && styles.tabOn,
                pressed && { opacity: 0.75 },
              ]}
            >
              <Text style={[styles.tabText, tab === t.key && styles.tabTextOn]}>
                {t.label}
                {t.key === 'active' && activeWork.data?.length ? ` (${activeWork.data.length})` : ''}
              </Text>
            </Pressable>
          ))}
        </View>

        {tab === 'active' ? <ActiveWorkList q={activeWork} /> : null}
        {tab === 'work' ? <WorkList q={work} /> : null}
        {tab === 'damage' ? <DamageList q={damage} /> : null}
        {tab === 'payments' ? <PaymentsList q={payments} /> : null}
      </ScrollView>
    </Screen>
  );
}

/**
 * Every stage currently in this partner's hands (repeat `handed_off` to them).
 *
 * The only place on this dashboard with an action. "Handover to delivery
 * person" flags the piece as finished so the Delivery Person's Orders list
 * pulls it to the top — custody itself only moves when they physically collect
 * it, which is why the row stays here afterwards, marked as awaiting pickup.
 */
function ActiveWorkList({ q }: { q: any }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const ready = useMutation({
    mutationFn: (repeatId: string) => markPartnerReady(repeatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partner', 'activeWork'] });
      queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
    },
    onError: (e) => setError(describeDbError(e, 'Handover')),
  });

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Text style={styles.error}>{describeDbError(q.error, 'Active work')}</Text>;

  const rows = (q.data ?? []) as any[];
  if (rows.length === 0) {
    return (
      <Text style={styles.empty}>
        Nothing with you right now. Work appears here the moment the delivery person hands a
        stage over to you.
      </Text>
    );
  }

  return (
    <View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {rows.map((r) => {
        const stage = (r.stage_type ?? 'stage').replace(/_/g, ' ');
        const waiting = !!r.partner_ready_at;
        return (
          <View key={r.repeat_id} style={[styles.activeCard, r.sla_breached && styles.activeCardLate]}>
            <View style={styles.activeTop}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.activeCode}>{r.repeat_code}</Text>
                <Text style={styles.rowMeta}>
                  {r.order_code} · {r.vendor_name}
                </Text>
                <Text style={styles.rowMeta}>
                  Stage {r.stage_sequence ?? '—'} of {r.total_stages} · {stage}
                  {r.color_assignment ? ` · ${r.color_assignment}` : ''}
                </Text>
                {r.handed_off_at ? (
                  <Text style={styles.rowMeta}>
                    With you since {new Date(r.handed_off_at).toLocaleDateString()}
                    {r.sla_hours ? ` · ${r.sla_hours}h SLA` : ''}
                  </Text>
                ) : null}
              </View>
              <View style={{ gap: 6, alignItems: 'flex-end' }}>
                {r.sla_breached ? <StatusPill label="Past SLA" color={colors.alert} /> : null}
                {waiting ? <StatusPill label="Awaiting pickup" color={colors.success} /> : null}
              </View>
            </View>

            {waiting ? (
              <Text style={styles.rowMeta}>
                Marked finished — the delivery person will collect it.
              </Text>
            ) : (
              <AppButton
                title="Handover to delivery person"
                variant="brass"
                size="sm"
                loading={ready.isPending && ready.variables === r.repeat_id}
                onPress={() => {
                  setError(null);
                  ready.mutate(r.repeat_id);
                }}
                style={{ marginTop: spacing.sm }}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

function SummaryCard({ q, period }: { q: any; period: string }) {
  if (q.isLoading) return <Spinner />;
  if (q.isError)
    return <Text style={styles.error}>{describeDbError(q.error, 'Earnings')}</Text>;

  const s = q.data as any;
  const net = s?.net_receivable ?? 0;
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryLabel}>
        Net receivable · {period}
      </Text>
      <Text style={[styles.hero, net < 0 && { color: colors.alert }]}>{Number(net).toLocaleString()}</Text>
      <View style={styles.summaryGrid}>
        <Stat label="Earnings" value={s?.total_earnings ?? 0} />
        <Stat label="Damage charges" value={s?.total_damage_charges ?? 0} alert={true} />
        <Stat label="Payments received" value={s?.total_payments ?? 0} />
      </View>
    </View>
  );
}

function Stat({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, alert && value < 0 && { color: colors.alert }]}>
        {Number(value).toLocaleString()}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function WorkList({ q }: { q: any }) {
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Text style={styles.error}>{describeDbError(q.error, 'Work')}</Text>;
  const rows = q.data ?? [];
  if (rows.length === 0)
    return <Text style={styles.empty}>No completed work in this period yet.</Text>;
  return (
    <View style={styles.rows}>
      {rows.map((w: any) => (
        <View key={w.repeat_id} style={styles.row}>
          <View style={styles.rowTop}>
            <Text style={styles.code}>{w.repeat_code}</Text>
            <Text style={styles.rowMeta}>
              <Text style={styles.mono}>{Number(w.earning_amount).toLocaleString()}</Text>
            </Text>
          </View>
          <Text style={styles.rowBody}>
            {w.order_code ?? '—'} · {w.stage_type}
            {w.stitch_count > 0 ? ` · ${w.stitch_count} stitches` : ''}
          </Text>
          <Text style={styles.rowMeta}>
            {w.completed_at ? new Date(w.completed_at).toLocaleString() : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

function DamageList({ q }: { q: any }) {
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Text style={styles.error}>{describeDbError(q.error, 'Damage')}</Text>;
  const rows = q.data ?? [];
  if (rows.length === 0)
    return <Text style={styles.empty}>No damage charges in this period.</Text>;
  return (
    <View style={styles.rows}>
      {rows.map((d: any) => (
        <View key={d.id} style={styles.row}>
          <View style={styles.rowTop}>
            <Text style={styles.code}>{d.repeat_code ?? '—'}</Text>
            <Text style={[styles.rowMeta, { color: colors.alert }]}>
              <Text style={styles.mono}>{Number(d.amount).toLocaleString()}</Text>
            </Text>
          </View>
          <Text style={styles.rowBody}>
            {d.order_code ?? '—'} · {d.stage_type} · {d.damage_type}
          </Text>
          <Text style={styles.rowMeta}>{new Date(d.created_at).toLocaleString()}</Text>
        </View>
      ))}
    </View>
  );
}

function PaymentsList({ q }: { q: any }) {
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Text style={styles.error}>{describeDbError(q.error, 'Payments')}</Text>;
  const rows = q.data ?? [];
  if (rows.length === 0)
    return <Text style={styles.empty}>No payments received yet.</Text>;
  return (
    <View style={styles.rows}>
      {rows.map((p: any) => (
        <View key={p.id} style={styles.row}>
          <View style={styles.rowTop}>
            <Text style={styles.code}>{Number(p.amount).toLocaleString()}</Text>
            <Text style={styles.rowMeta}>{p.period}</Text>
          </View>
          <Text style={styles.rowBody}>
            Paid on {new Date(p.created_at).toLocaleString()}
            {p.created_by_name ? ` by ${p.created_by_name}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Spinner() {
  return <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />;
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  subtitle: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  stitch: { marginVertical: spacing.lg, paddingHorizontal: spacing.xl },
  periods: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.xl },
  period: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  periodOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  periodText: { fontSize: fontSize.caption, color: colors.slate, fontWeight: fontWeight.medium },
  periodTextOn: { color: colors.white },
  summary: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  summaryLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, marginTop: spacing.sm },
  hero: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  stat: { gap: 1 },
  statValue: { fontFamily: fontFamily.mono, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  statLabel: { fontSize: fontSize.caption, color: colors.slate },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.xl },
  tab: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  tabText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    fontWeight: fontWeight.medium,
  },
  tabTextOn: { color: colors.white, fontWeight: fontWeight.semibold },
  rows: { paddingHorizontal: spacing.xl },
  row: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  rowBody: { fontSize: fontSize.secondary, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  activeCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  activeCardLate: { borderColor: colors.alert },
  activeTop: { flexDirection: 'row', gap: spacing.md },
  activeCode: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  rowMeta: { fontSize: fontSize.caption, color: colors.slate },
  error: { padding: spacing.lg, fontSize: fontSize.secondary, color: colors.alert },
  empty: { padding: spacing.xl, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
