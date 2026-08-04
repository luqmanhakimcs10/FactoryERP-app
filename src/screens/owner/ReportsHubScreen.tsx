/**
 * Reports Hub — five reports, all pure reads over tables earlier phases wrote.
 *
 * Per-order profitability gets its own screen and real layout: it is the
 * product's stated differentiator, and a single margin number would hide the
 * thing an owner actually wants, which is WHERE the money went on this order.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ListRow } from '../../components/lists/ListRow';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import {
  reportCompanyPl,
  reportOrderProfitability,
  reportInventoryLeakage,
  reportWorkerProductivity,
  reportMachineUptime,
  type OrderProfit,
} from '../../api/endpoints/finance';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

const money = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------
export function ReportsHubScreen() {
  const navigation = useNavigation<any>();
  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing.xl }}>
        <Text style={styles.hubIntro}>
          Every report reads the transactions earlier phases recorded — nothing
          here keeps its own copy of the numbers.
        </Text>
        <View style={styles.rows}>
          <ListRow
            title="Per-order profitability"
            subtitle="Revenue vs thread, labour, finishing and overhead"
            pillLabel="Key"
            pillColor={colors.brass}
            onPress={() => navigation.navigate('ReportProfitability')}
          />
          <ListRow title="Company P&L" subtitle="Revenue against all costs" onPress={() => navigation.navigate('ReportPl')} />
          <ListRow title="Inventory consumption & leakage" subtitle="Issued vs audited, per colour" onPress={() => navigation.navigate('ReportLeakage')} />
          <ListRow title="Worker productivity" subtitle="Stitches, pay and deductions per worker" onPress={() => navigation.navigate('ReportProductivity')} />
          <ListRow title="Machine uptime" subtitle="Run time, downtime and idle shifts" onPress={() => navigation.navigate('ReportUptime')} />
        </View>
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 1. Per-order profitability — the differentiator
// ---------------------------------------------------------------------------
export function ProfitabilityReportScreen() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reportProfitability'],
    queryFn: () => reportOrderProfitability(),
  });

  if (isLoading) {
    return <Screen><ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} /></Screen>;
  }
  if (isError) {
    return <Screen><Text style={styles.emptyBody}>{describeDbError(error, 'Report')}</Text></Screen>;
  }

  const rows = data ?? [];
  const invoiced = rows.filter((r) => r.revenue > 0);
  const totalProfit = invoiced.reduce((n, r) => n + Number(r.profit), 0);
  const totalRevenue = invoiced.reduce((n, r) => n + Number(r.revenue), 0);
  const open = rows.find((r) => r.order_id === selected);

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.order_id}
        ListHeaderComponent={
          <View>
            <View style={styles.heroBlock}>
              <Text style={styles.heroLabel}>Profit across {invoiced.length} invoiced order{invoiced.length === 1 ? '' : 's'}</Text>
              <Text style={[styles.heroNumber, totalProfit < 0 && { color: colors.alert }]}>
                {money(totalProfit)}
              </Text>
              <Text style={styles.heroSub}>
                on {money(totalRevenue)} revenue
                {totalRevenue > 0 ? ` · ${((totalProfit / totalRevenue) * 100).toFixed(1)}% margin` : ''}
              </Text>
              <View style={{ marginTop: spacing.md }}>
                <StitchLine />
              </View>
            </View>
            <Text style={styles.sectionTitle}>By order</Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No orders yet</Text>
          </View>
        }
        renderItem={({ item }) => (
          <OrderProfitCard
            row={item}
            expanded={selected === item.order_id}
            onToggle={() => setSelected(selected === item.order_id ? null : item.order_id)}
          />
        )}
        ListFooterComponent={
          <Text style={styles.footnote}>
            Thread is valued at the average cost per metre actually paid to
            suppliers. Overhead is shared evenly across invoiced orders — a
            deliberately simple split, stated rather than dressed up as precision
            the data cannot support.
          </Text>
        }
      />
    </Screen>
  );
}

/** One order's full breakdown — the point is showing where the money went. */
function OrderProfitCard({
  row,
  expanded,
  onToggle,
}: {
  row: OrderProfit;
  expanded: boolean;
  onToggle: () => void;
}) {
  const revenue = Number(row.revenue);
  const costs = [
    { label: 'Thread', value: Number(row.thread_cost), color: colors.brass },
    { label: 'Labour', value: Number(row.labor_cost), color: colors.indigo },
    { label: 'Finishing', value: Number(row.finishing_cost), color: colors.warning },
    { label: 'Overhead', value: Number(row.fixed_allocated), color: colors.slate },
  ];
  const totalCost = Number(row.total_cost);
  const profit = Number(row.profit);
  const denom = Math.max(revenue, totalCost, 1);

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      style={({ pressed }) => [styles.profitCard, pressed && { backgroundColor: colors.pressed }]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.code}>{row.order_code}</Text>
        {revenue > 0 ? (
          <StatusPill
            label={`${profit >= 0 ? '+' : ''}${money(profit)}`}
            color={profit >= 0 ? colors.success : colors.alert}
          />
        ) : (
          <StatusPill label="Not invoiced" color={colors.slate} />
        )}
      </View>
      <Text style={styles.vendor} numberOfLines={1}>{row.vendor_name}</Text>

      {/* Cost composition bar — proportions read faster than four numbers. */}
      <View style={styles.bar}>
        {costs.map((c) =>
          c.value > 0 ? (
            <View
              key={c.label}
              style={{ width: `${(c.value / denom) * 100}%`, backgroundColor: c.color, height: 8 }}
            />
          ) : null
        )}
        {profit > 0 ? (
          <View style={{ width: `${(profit / denom) * 100}%`, backgroundColor: colors.tintTeal, height: 8 }} />
        ) : null}
      </View>

      <Text style={styles.meta}>
        Revenue <Text style={styles.mono}>{money(revenue)}</Text> · cost{' '}
        <Text style={styles.mono}>{money(totalCost)}</Text>
        {row.margin_pct != null ? ` · ${row.margin_pct}% margin` : ''}
      </Text>

      {expanded ? (
        <View style={styles.breakdown}>
          <BreakRow label="Revenue" value={revenue} strong />
          {row.invoice_code ? (
            <Text style={styles.invoiceRef}>Invoice <Text style={styles.mono}>{row.invoice_code}</Text></Text>
          ) : (
            <Text style={styles.invoiceRef}>No invoice raised yet</Text>
          )}
          <View style={styles.divider} />
          {costs.map((c) => (
            <BreakRow key={c.label} label={c.label} value={-c.value} dot={c.color} />
          ))}
          <View style={styles.divider} />
          <BreakRow label="Profit" value={profit} strong />
        </View>
      ) : (
        <Text style={styles.action}>Tap for full breakdown →</Text>
      )}
    </Pressable>
  );
}

function BreakRow({
  label, value, strong, dot,
}: { label: string; value: number; strong?: boolean; dot?: string }) {
  return (
    <View style={styles.breakRow}>
      <View style={styles.breakLabelWrap}>
        {dot ? <View style={[styles.dot, { backgroundColor: dot }]} /> : null}
        <Text style={[styles.breakLabel, strong && styles.breakStrong]}>{label}</Text>
      </View>
      <Text
        style={[
          styles.breakValue,
          strong && styles.breakStrong,
          value < 0 && { color: colors.slate },
          strong && value < 0 && { color: colors.alert },
        ]}
      >
        {value < 0 ? '−' : ''}{money(Math.abs(value))}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 2. Company P&L
// ---------------------------------------------------------------------------
export function PlReportScreen() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reportPl'],
    queryFn: () => reportCompanyPl(),
  });

  if (isLoading) return <Screen><ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} /></Screen>;
  if (isError || !data) return <Screen><Text style={styles.emptyBody}>{describeDbError(error, 'Report')}</Text></Screen>;

  const profit = Number(data.net_profit);
  return (
    <Screen>
      <ScrollView>
        <Text style={styles.heroLabel}>Net profit</Text>
        <Text style={[styles.heroNumber, profit < 0 && { color: colors.alert }]}>{money(profit)}</Text>
        <View style={{ marginVertical: spacing.lg }}><StitchLine /></View>

        <Text style={styles.sectionTitleInline}>Revenue</Text>
        <BreakRow label="Invoiced" value={Number(data.revenue_invoiced)} strong />
        <BreakRow label="Collected in cash" value={Number(data.revenue_collected)} />

        <Text style={styles.sectionTitleInline}>Costs</Text>
        <BreakRow label="Thread consumed" value={-Number(data.thread_cost)} />
        <BreakRow label="Labour" value={-Number(data.labor_cost)} />
        <BreakRow label="Finishing partners" value={-Number(data.finishing_cost)} />
        <BreakRow label="Other expenses" value={-Number(data.other_expenses)} />
        <View style={styles.divider} />
        <BreakRow label="Total cost" value={-Number(data.total_cost)} strong />

        <Text style={styles.footnote}>
          Revenue is counted when invoiced; cash collected is shown alongside so a
          gap between billing and payment stays visible rather than hidden.
        </Text>
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 3. Inventory leakage
// ---------------------------------------------------------------------------
export function LeakageReportScreen() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reportLeakage'],
    queryFn: reportInventoryLeakage,
  });

  if (isLoading) return <Screen><ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} /></Screen>;
  if (isError) return <Screen><Text style={styles.emptyBody}>{describeDbError(error, 'Report')}</Text></Screen>;

  return (
    <Screen padded={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.color_code}
        ListHeaderComponent={
          <Text style={styles.hubIntro}>
            Audit variance is the leakage signal: thread that left the shelf with
            no issue behind it.
          </Text>
        }
        ListEmptyComponent={<View style={styles.center}><Text style={styles.emptyTitle}>No stock movements yet</Text></View>}
        renderItem={({ item }) => {
          const variance = Number(item.audit_variance);
          return (
            <View style={styles.row}>
              <View style={styles.rowTop}>
                <Text style={styles.code}>{item.color_code}</Text>
                {variance !== 0 ? (
                  <StatusPill
                    label={`${variance > 0 ? '+' : ''}${money(variance)} m`}
                    color={variance < 0 ? colors.alert : colors.warning}
                  />
                ) : (
                  <StatusPill label="No variance" color={colors.success} />
                )}
              </View>
              <Text style={styles.meta}>
                Opening <Text style={styles.mono}>{money(item.opening_meters)}</Text>
                {' · received '}<Text style={styles.mono}>{money(item.received_meters)}</Text>
                {' · issued '}<Text style={styles.mono}>{money(item.issued_meters)}</Text>
              </Text>
              <Text style={styles.meta}>
                Balance <Text style={styles.mono}>{money(item.current_balance)}</Text> m
                {item.leakage_pct != null ? ` · ${item.leakage_pct}% of issued` : ''}
                {' · '}{item.movement_count} movements
              </Text>
            </View>
          );
        }}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 4. Worker productivity
// ---------------------------------------------------------------------------
export function ProductivityReportScreen() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reportProductivity'],
    queryFn: () => reportWorkerProductivity(),
  });

  if (isLoading) return <Screen><ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} /></Screen>;
  if (isError) return <Screen><Text style={styles.emptyBody}>{describeDbError(error, 'Report')}</Text></Screen>;

  return (
    <Screen padded={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.worker_id}
        ListEmptyComponent={<View style={styles.center}><Text style={styles.emptyTitle}>No workers yet</Text></View>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={styles.vendor}>{item.worker_name}</Text>
              <Text style={styles.mono}>{Number(item.total_stitches).toLocaleString()} st</Text>
            </View>
            <Text style={styles.meta}>
              {item.shifts_worked} shift{item.shifts_worked === 1 ? '' : 's'} · avg{' '}
              <Text style={styles.mono}>{money(item.avg_stitches)}</Text>/shift
              {item.damage_count > 0 ? ` · ${item.damage_count} damage record(s)` : ''}
            </Text>
            <Text style={styles.meta}>
              Gross <Text style={styles.mono}>{money(item.gross_pay)}</Text>
              {' + bonus '}<Text style={styles.mono}>{money(item.bonus)}</Text>
              {Number(item.damage_deduction) > 0 ? <> {' − damage '}<Text style={styles.mono}>{money(item.damage_deduction)}</Text></> : null}
              {Number(item.loan_installment) > 0 ? <> {' − loan '}<Text style={styles.mono}>{money(item.loan_installment)}</Text></> : null}
              {' = '}<Text style={[styles.mono, { fontWeight: fontWeight.semibold }]}>{money(item.net_pay)}</Text>
            </Text>
          </View>
        )}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// 5. Machine uptime
// ---------------------------------------------------------------------------
export function UptimeReportScreen() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reportUptime'],
    queryFn: () => reportMachineUptime(),
  });

  if (isLoading) return <Screen><ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} /></Screen>;
  if (isError) return <Screen><Text style={styles.emptyBody}>{describeDbError(error, 'Report')}</Text></Screen>;

  return (
    <Screen padded={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.machine_id}
        ListHeaderComponent={
          <Text style={styles.hubIntro}>
            Idle-flagged shifts are counted separately from reported downtime — an
            idle counter is a different fact from a reported stoppage.
          </Text>
        }
        ListEmptyComponent={<View style={styles.center}><Text style={styles.emptyTitle}>No machines yet</Text></View>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={styles.code}>{item.machine_name}</Text>
              {item.uptime_pct != null ? (
                <StatusPill
                  label={`${item.uptime_pct}% up`}
                  color={item.uptime_pct >= 90 ? colors.success : item.uptime_pct >= 70 ? colors.warning : colors.alert}
                />
              ) : (
                <StatusPill label="No closed shifts" color={colors.slate} />
              )}
            </View>
            <Text style={styles.meta}>
              {item.shifts_closed} closed · {item.shifts_idle} idle-flagged of {item.shifts_total} total
            </Text>
            <Text style={styles.meta}>
              Run <Text style={styles.mono}>{money(item.run_minutes)}</Text> min
              {' · downtime '}<Text style={styles.mono}>{money(item.downtime_minutes)}</Text> min
              {' · '}<Text style={styles.mono}>{Number(item.total_stitches).toLocaleString()}</Text> stitches
            </Text>
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hubIntro: { padding: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  rows: { paddingHorizontal: spacing.lg },
  heroBlock: { padding: spacing.xl, paddingBottom: 0 },
  heroLabel: {
    fontSize: fontSize.caption, fontWeight: fontWeight.medium, color: colors.slate,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  heroNumber: { fontSize: fontSize.hero, fontFamily: fontFamily.mono, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  heroSub: { fontSize: fontSize.secondary, color: colors.slate },
  sectionTitle: {
    paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm,
    fontSize: fontSize.caption, fontWeight: fontWeight.medium, color: colors.slate,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  sectionTitleInline: {
    marginTop: spacing.lg, marginBottom: spacing.sm,
    fontSize: fontSize.caption, fontWeight: fontWeight.medium, color: colors.slate,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  profitCard: {
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 4,
  },
  row: {
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 2,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  vendor: { fontSize: fontSize.secondary, color: colors.indigoDeep, flexShrink: 1 },
  meta: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  action: { marginTop: 2, fontSize: fontSize.caption, color: colors.brass, fontWeight: fontWeight.semibold },
  bar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.border, marginVertical: 4 },
  breakdown: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  breakRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: spacing.md },
  breakLabelWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  breakLabel: { fontSize: fontSize.secondary, color: colors.slate },
  breakValue: { fontSize: fontSize.secondary, fontFamily: fontFamily.mono, color: colors.indigoDeep },
  breakStrong: { fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  invoiceRef: { fontSize: fontSize.caption, color: colors.slate },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  footnote: { padding: spacing.lg, fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic', lineHeight: 18 },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { padding: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
