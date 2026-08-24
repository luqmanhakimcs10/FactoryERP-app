/**
 * The finishing partner's portal — what their bookmarkable link opens.
 *
 * No login, no navigator, no session. It is mounted by RootNavigator before the
 * auth branch when the URL carries a partner token, so a partner who opens
 * their link never sees the login screen at all.
 *
 * IT IS READ-ONLY (0092). The partner does the physical work and hands the
 * piece back when the delivery person arrives; nothing they press moves a piece
 * forward, and nothing the delivery person does waits on them. This page
 * answers one question — what is with me, and since when — plus three summary
 * numbers, including this month's earnings.
 *
 * The "handover to delivery person" button was here. It never moved custody
 * (0062 was explicit that it was a signal, not a gate), but a piece nobody
 * pressed it for looked like a piece nobody had finished, which is exactly the
 * dependency the brief removes.
 *
 * ON PUTTING EARNINGS HERE: this URL is only as private as whoever the partner
 * forwards it to, so `partner_portal_stats` returns the three figures the cards
 * show and nothing else. The damage-charge detail, payment history and net
 * receivable that the logged-in dashboard carries stay off the link.
 */
import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { StatusPill } from '../../components/ui/StatusPill';
import { StitchLine } from '../../components/ui/StitchLine';
import { MetricCard, MetricRow, MetricsSection } from '../../components/ui/MetricCard';
import { statCount, statMoney } from '../../utils/statValue';
import {
  partnerPortalInfo,
  partnerPortalWork,
  partnerPortalStats,
  type PartnerPortalWorkRow,
} from '../../api/endpoints/partnerPortal';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export function PartnerPortalScreen({ token }: { token: string }) {
  const info = useQuery({
    queryKey: ['partnerPortal', 'info', token],
    queryFn: () => partnerPortalInfo(token),
    retry: false,
  });

  const work = useQuery({
    queryKey: ['partnerPortal', 'work', token],
    queryFn: () => partnerPortalWork(token),
    // The link is left open on a phone all day, and the list changes without
    // the partner touching anything — a piece leaves it when the delivery
    // person collects it.
    refetchInterval: 60_000,
    retry: false,
    enabled: !info.isError,
  });

  const stats = useQuery({
    queryKey: ['partnerPortal', 'stats', token],
    queryFn: () => partnerPortalStats(token),
    retry: false,
    enabled: !info.isError,
  });

  // A revoked (archived) partner, or a token that never existed. Same message
  // for both on purpose: telling a stranger which of the two it was is telling
  // them whether they guessed a real token.
  if (info.isError) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.title}>This link is no longer valid</Text>
          <Text style={styles.body}>
            Ask the factory for a new link — the one you have has been withdrawn.
          </Text>
        </View>
      </Screen>
    );
  }

  if (info.isLoading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </Screen>
    );
  }

  if (!info.data) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.title}>Temporarily unavailable</Text>
          <Text style={styles.body}>
            This factory's account is not active right now. Your work will be here again once it
            is.
          </Text>
        </View>
      </Screen>
    );
  }

  const rows = work.data ?? [];

  return (
    <Screen padded={false}>
      <View style={styles.header}>
        <Text style={styles.headerName}>{info.data.partner_name}</Text>
        <Text style={styles.headerMeta}>
          {info.data.factory_name}
          {info.data.stage_type ? ` · ${info.data.stage_type.replace(/_/g, ' ')}` : ''}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={work.isRefetching}
            onRefresh={work.refetch}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.stitch}>
          <StitchLine />
        </View>

        <View style={styles.metrics}>
          <MetricsSection title="Your month" subtitle="Work in hand and what it has earned">
            <MetricRow>
              <MetricCard
                label="Active work items"
                value={statCount(stats.isError ? undefined : stats.data?.active_items)}
                icon="cube-outline"
                accent={stats.data?.active_items ? 'amber' : 'teal'}
              />
              <MetricCard
                label="Completed this month"
                value={statCount(stats.isError ? undefined : stats.data?.completed_this_month)}
                icon="checkmark-done-outline"
                accent="teal"
              />
              <MetricCard
                label="Earnings this month"
                value={stats.isError ? '—' : statMoney(stats.data?.earnings_this_month)}
                icon="cash-outline"
                accent="green"
                emphasis
              />
            </MetricRow>
          </MetricsSection>
        </View>

        <Text style={styles.sectionTitle}>
          With you now{rows.length ? ` (${rows.length})` : ''}
        </Text>

        {work.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
        {work.isError ? (
          <Text style={styles.error}>{describeDbError(work.error, 'Your work')}</Text>
        ) : null}

        {!work.isLoading && rows.length === 0 ? (
          <Text style={styles.empty}>
            Nothing with you right now. Work appears here the moment the delivery person hands a
            stage over to you — keep this page bookmarked.
          </Text>
        ) : null}

        {rows.map((r) => (
          <WorkCard key={r.repeat_id} row={r} />
        ))}
      </ScrollView>
    </Screen>
  );
}

function WorkCard({ row }: { row: PartnerPortalWorkRow }) {
  const stage = (row.stage_type ?? 'stage').replace(/_/g, ' ');

  return (
    <View style={[styles.card, row.sla_breached && styles.cardLate]}>
      <View style={styles.cardTop}>
        <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
          <Text style={styles.code}>{row.repeat_code}</Text>
          <Text style={styles.meta}>
            {row.order_code ?? '—'} · {row.vendor_name}
          </Text>
          <Text style={styles.meta}>
            Stage {row.stage_sequence ?? '—'} of {row.total_stages} · {stage}
            {row.color_assignment ? ` · ${row.color_assignment}` : ''}
          </Text>
          {row.handed_off_at ? (
            <Text style={styles.meta}>
              With you since {new Date(row.handed_off_at).toLocaleDateString()}
              {row.sla_hours ? ` · ${row.sla_hours}h SLA` : ''}
            </Text>
          ) : null}
        </View>
        <View style={{ gap: 6, alignItems: 'flex-end' }}>
          {row.sla_breached ? <StatusPill label="Past SLA" color={colors.alert} /> : null}
          <StatusPill label="With you" color={colors.progressActive} />
        </View>
      </View>

      <Text style={styles.meta}>
        Hand it back to the delivery person when it is done. There is nothing to press here — it
        leaves this list the moment they collect it.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  headerName: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  headerMeta: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.tintTeal },
  content: { padding: spacing.xl, paddingBottom: spacing.xxl },
  stitch: { marginBottom: spacing.lg },
  metrics: { marginBottom: spacing.lg },
  sectionTitle: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
    marginBottom: spacing.md,
  },
  card: {
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardLate: { borderColor: colors.alert },
  cardTop: { flexDirection: 'row', gap: spacing.md },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  meta: { fontSize: fontSize.caption, color: colors.inkMuted },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.ink },
  body: {
    fontSize: fontSize.body,
    color: colors.inkMuted,
    lineHeight: 22,
    textAlign: 'center',
  },
  error: { marginBottom: spacing.sm, fontSize: fontSize.secondary, color: colors.alert },
  empty: {
    paddingVertical: spacing.lg,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    lineHeight: 20,
  },
});

export default PartnerPortalScreen;
