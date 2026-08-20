/**
 * Worker Dashboard — the worker's home screen.
 *
 * Headline: the latest ledger row for the current period. Around it, the
 * worker's current shift (with a downtime report entry point), any active loan,
 * and navigation to the salary breakdown and leave request screens.
 *
 * All reads come from SECURITY DEFINER RPCs scoped to auth.uid(); if the
 * machine_workforce module is off for the factory, the reads error cleanly and
 * the screen explains why instead of crashing.
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { MetricCard, MetricRow, MetricsSection } from '../../components/ui/MetricCard';
import { statCount, statMoney, statBigCount } from '../../utils/statValue';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import { ListRow } from '../../components/lists/ListRow';
import { AppButton } from '../../components/ui/AppButton';
import { useAuth } from '../../auth/AuthContext';
import {
  getWorkerLatestLedger,
  getWorkerCurrentShift,
  getWorkerActiveLoan,
  getWorkerLeaveHistory,
} from '../../api/endpoints/dashboards';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

export function WorkerDashboardScreen() {
  const navigation = useNavigation<any>();
  const { profile } = useAuth();

  const ledger = useQuery({
    queryKey: ['worker', 'latestLedger'],
    queryFn: getWorkerLatestLedger,
  });
  const shift = useQuery({
    queryKey: ['worker', 'currentShift'],
    queryFn: getWorkerCurrentShift,
  });
  const loan = useQuery({
    queryKey: ['worker', 'activeLoan'],
    queryFn: getWorkerActiveLoan,
  });
  /**
   * LEAVE. There is no leave BALANCE anywhere in this system — no entitlement is
   * configured per employee, so nothing can be counted down from. The closest
   * live figure is how many days have been approved, which is what this shows
   * and what the label says. Flagged rather than invented.
   */
  const leave = useQuery({
    queryKey: ['worker', 'leaveHistory'],
    queryFn: getWorkerLeaveHistory,
  });
  /*
   * NO EARNINGS TREND, and the reason is worth writing down.
   *
   * `worker_ledger` does keep a row per shift with its own `created_at`, so the
   * series exists in the table. But `worker_get_ledger_entries` is PERIOD-SCOPED
   * — called with no argument it returns the current payroll period only. Fed
   * to `periodTrend` that yields 0,0,0,0,0,X: five months of "this worker
   * earned nothing", invented by the query's own filter rather than by the
   * data. Six calls, or a new RPC, would fix it; the brief says not to add
   * heavy queries or backend for a dashboard figure, so the card shows the
   * number without a line.
   */

  /**
   * A ledger figure, or the right kind of blank.
   *
   * `getWorkerLatestLedger` returns null both while it is loading and when the
   * worker simply has no row for this period. Those are different facts, and a
   * card that shows an em-dash for the second one is telling a worker who has
   * not been paid yet that the app does not know.
   */
  function ledgerFigure(
    v: number | null | undefined,
    fmt: (n: number | null | undefined) => string
  ): string {
    if (ledger.isLoading || ledger.isError) return '—';
    return fmt(v ?? 0);
  }

  /**
   * Whole days across every APPROVED leave record, inclusive of both ends.
   * Pending and rejected requests are not leave taken.
   */
  const leaveDays =
    leave.data === undefined
      ? undefined
      : leave.data
          .filter((l) => l.status === 'approved')
          .reduce((n, l) => {
            const from = new Date(l.start_date).getTime();
            const to = new Date(l.end_date).getTime();
            if (Number.isNaN(from) || Number.isNaN(to) || to < from) return n;
            return n + Math.round((to - from) / 86400000) + 1;
          }, 0);

  return (
    <Screen padded={false}>
      <DashboardHeader navigation={navigation} />
      <View style={{ paddingHorizontal: 16, paddingTop: 16 }}><TaskBanners /></View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={ledger.isRefetching || shift.isRefetching}
            onRefresh={() => {
              ledger.refetch();
              shift.refetch();
              loan.refetch();
            }}
            tintColor={colors.indigo}
          />
        }
      >
        <View style={styles.header}>
          <Text style={styles.title}>My Dashboard</Text>
          <Text style={styles.subtitle}>{profile?.display_name ?? 'Worker'}</Text>
        </View>
        <View style={styles.stitch}>
          <StitchLine />
        </View>

        <View style={styles.metrics}>
          <MetricsSection subtitle="Your period so far">
            <MetricRow>
              {/* `ledgerFigure` distinguishes the two things an absent number
                  can mean. Still loading, or the read failed -> em-dash.
                  Loaded, with no ledger row for this period -> the worker has
                  earned nothing yet, and 0 is the true answer, not a shrug. */}
              <MetricCard
                label="Stitches this period"
                value={ledgerFigure(ledger.data?.stitch_count, statBigCount)}
                icon="git-commit-outline"
                accent="teal"
              />
              <MetricCard
                label="Earnings this period"
                value={ledgerFigure(ledger.data?.net, statMoney)}
                icon="cash-outline"
                accent="green"
                emphasis
              />
              <MetricCard
                label="Bonus earned"
                value={ledgerFigure(ledger.data?.bonus, statMoney)}
                icon="trophy-outline"
                accent="amber"
              />
              <MetricCard
                label="Leave days approved"
                value={statCount(leaveDays)}
                icon="calendar-outline"
                accent="rose"
                onPress={() => navigation.navigate('LeaveRequest')}
              />
            </MetricRow>
          </MetricsSection>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>This period</Text>
          <LedgerCard q={ledger} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>My shift</Text>
          <ShiftCard
            q={shift}
            onReportDowntime={(shiftId: string) =>
              navigation.navigate('ReportDowntime', { shiftId })
            }
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Loan</Text>
          <LoanCard q={loan} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>My records</Text>
          <View style={styles.rows}>
            <ListRow
              title="Salary breakdown"
              subtitle="Shift-by-shift earnings, bonuses, deductions"
              onPress={() => navigation.navigate('SalaryBreakdown')}
            />
            <ListRow
              title="Leave request"
              subtitle="Request time off and track approvals"
              onPress={() => navigation.navigate('LeaveRequest')}
            />
            {shift.data?.status === 'open' ? (
              <ListRow
                title="Report downtime"
                subtitle="Machine stopped mid-shift? Log it here"
                onPress={() => navigation.navigate('ReportDowntime', { shiftId: shift.data!.id })}
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

/** Latest ledger row for the current period. */
function LedgerCard({ q }: { q: any }) {
  if (q.isLoading) return <CardPlaceholder />;
  if (q.isError) return <CardError message={describeDbError(q.error, 'Ledger')} />;

  const row = q.data as any;
  if (!row) {
    return (
      <Card>
        <Text style={styles.cardTitle}>No shifts recorded yet</Text>
        <Text style={styles.cardBody}>
          Your earnings appear here after the floor manager closes your shifts.
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <View style={styles.cardRow}>
        <Text style={styles.cardTitle}>Net earnings · {row.period}</Text>
        <StatusPill
          label={row.status === 'finalized' ? 'Finalized' : 'Pending'}
          color={row.status === 'finalized' ? colors.success : colors.warning}
        />
      </View>
      <Text style={styles.hero}>{Number(row.net).toLocaleString()}</Text>
      <Text style={styles.cardBody}>
        <Text style={styles.mono}>{row.stitch_count}</Text> stitches ·{' '}
        <Text style={styles.mono}>{Number(row.bonus).toLocaleString()}</Text> bonus
        {row.damage_deduction > 0 ? (
          <>
            {' · '}
            <Text style={styles.mono}>{Number(row.damage_deduction).toLocaleString()}</Text> deduction
          </>
        ) : null}
        {row.loan_installment > 0 ? (
          <>
            {' · '}
            <Text style={styles.mono}>{Number(row.loan_installment).toLocaleString()}</Text> loan
          </>
        ) : null}
      </Text>
      {row.payment_proof_url ? (
        <Text style={styles.cardBody}>Payment proof attached — see your salary breakdown.</Text>
      ) : null}
    </Card>
  );
}

/** Current (or most recent) shift with a downtime entry point when open. */
function ShiftCard({ q, onReportDowntime }: { q: any; onReportDowntime: (id: string) => void }) {
  if (q.isLoading) return <CardPlaceholder />;
  if (q.isError) return <CardError message={describeDbError(q.error, 'Shift')} />;

  const s = q.data as any;
  if (!s) {
    return (
      <Card>
        <Text style={styles.cardTitle}>No shift assigned</Text>
        <Text style={styles.cardBody}>
          Your current or most recent shift will show here with its machine and order.
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <View style={styles.cardRow}>
        <Text style={styles.cardTitle}>{s.machine_name}</Text>
        <StatusPill
          label={s.status === 'open' ? 'Open' : 'Closed'}
          color={s.status === 'open' ? colors.success : colors.slate}
        />
      </View>
      <Text style={styles.cardBody}>
        {s.order_code ?? 'No order linked'} · opened{' '}
        {new Date(s.opened_at).toLocaleString()}
      </Text>
      {s.status === 'open' ? (
        <View style={styles.cardAction}>
          <AppButton
            title="Report downtime"
            variant="secondary"
            onPress={() => onReportDowntime(s.id)}
          />
        </View>
      ) : null}
    </Card>
  );
}

/** Active loan headline. */
function LoanCard({ q }: { q: any }) {
  if (q.isLoading) return <CardPlaceholder />;
  if (q.isError) return <CardError message={describeDbError(q.error, 'Loan')} />;

  const l = q.data as any;
  if (!l) {
    return (
      <Card>
        <Text style={styles.cardTitle}>No active loan</Text>
        <Text style={styles.cardBody}>Nothing is being deducted from your pay for a loan.</Text>
      </Card>
    );
  }

  return (
    <Card>
      <View style={styles.cardRow}>
        <Text style={styles.cardTitle}>Active loan</Text>
        <StatusPill label="Active" color={colors.indigo} />
      </View>
      <Text style={styles.hero}>{Number(l.balance).toLocaleString()}</Text>
      <Text style={styles.cardBody}>
        Remaining of{' '}
        <Text style={styles.mono}>{Number(l.principal).toLocaleString()}</Text> ·{' '}
        <Text style={styles.mono}>{Number(l.installment_amount).toLocaleString()}</Text> deducted per
        period
      </Text>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

function CardPlaceholder() {
  return (
    <Card>
      <ActivityIndicator color={colors.indigo} />
    </Card>
  );
}

function CardError({ message }: { message: string }) {
  return (
    <Card>
      <Text style={styles.cardTitle}>Unavailable</Text>
      <Text style={styles.cardBody}>{message}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  metrics: { paddingHorizontal: spacing.xl, marginBottom: spacing.lg },
  content: { paddingBottom: spacing.xl },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  subtitle: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  stitch: { marginVertical: spacing.lg, paddingHorizontal: spacing.xl },
  section: { marginBottom: spacing.xl },
  sectionLabel: {
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    marginHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  cardBody: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  hero: {
    fontFamily: fontFamily.monoSemibold,
    fontSize: fontSize.hero,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  cardAction: { marginTop: spacing.md },
  rows: { paddingHorizontal: spacing.xl },
});
