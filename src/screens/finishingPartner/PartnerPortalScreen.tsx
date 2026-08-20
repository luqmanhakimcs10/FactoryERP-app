/**
 * The finishing partner's portal — what their bookmarkable link opens.
 *
 * No login, no navigator, no session. It is mounted by RootNavigator before the
 * auth branch when the URL carries a partner token, so a partner who opens
 * their link never sees the login screen at all.
 *
 * It carries what the partner's dashboard carried that they could ACT on — the
 * work in their hands and the "handover to delivery person" signal on each
 * piece — plus three summary numbers, including this month's earnings.
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { StatusPill } from '../../components/ui/StatusPill';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatCard, StatGrid } from '../../components/ui/StatGrid';
import { statCount, statMoney } from '../../utils/statValue';
import {
  partnerPortalInfo,
  partnerPortalWork,
  partnerPortalStats,
  partnerPortalMarkReady,
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
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);

  const info = useQuery({
    queryKey: ['partnerPortal', 'info', token],
    queryFn: () => partnerPortalInfo(token),
    retry: false,
  });

  const work = useQuery({
    queryKey: ['partnerPortal', 'work', token],
    queryFn: () => partnerPortalWork(token),
    // The link is left open on a phone all day; a stale list is the one thing
    // that makes the partner mark the wrong piece.
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

  const ready = useMutation({
    mutationFn: (repeatId: string) => partnerPortalMarkReady(token, repeatId),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['partnerPortal', 'work', token] });
      // The active count is one of the three cards, so it has to move with the
      // list it counts.
      queryClient.invalidateQueries({ queryKey: ['partnerPortal', 'stats', token] });
    },
    onError: (e) => setError(describeDbError(e, 'Handover')),
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
          <StatGrid>
            <StatCard
              label="Active work items"
              value={statCount(stats.isError ? undefined : stats.data?.active_items)}
              icon="cube-outline"
              tone={stats.data?.active_items ? 'attention' : 'neutral'}
            />
            <StatCard
              label="Completed this month"
              value={statCount(stats.isError ? undefined : stats.data?.completed_this_month)}
              icon="checkmark-done-outline"
            />
            <StatCard
              label="Earnings this month"
              value={stats.isError ? '—' : statMoney(stats.data?.earnings_this_month)}
              icon="cash-outline"
            />
          </StatGrid>
        </View>

        <Text style={styles.sectionTitle}>
          With you now{rows.length ? ` (${rows.length})` : ''}
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
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
          <WorkCard
            key={r.repeat_id}
            row={r}
            busy={ready.isPending && ready.variables === r.repeat_id}
            disabled={ready.isPending}
            onReady={() => {
              setError(null);
              ready.mutate(r.repeat_id);
            }}
          />
        ))}
      </ScrollView>
    </Screen>
  );
}

function WorkCard({
  row,
  busy,
  disabled,
  onReady,
}: {
  row: PartnerPortalWorkRow;
  busy: boolean;
  disabled: boolean;
  onReady: () => void;
}) {
  const stage = (row.stage_type ?? 'stage').replace(/_/g, ' ');
  const waiting = !!row.partner_ready_at;

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
          {waiting ? <StatusPill label="Awaiting pickup" color={colors.success} /> : null}
        </View>
      </View>

      {waiting ? (
        <Text style={styles.meta}>Marked finished — the delivery person will collect it.</Text>
      ) : (
        <AppButton
          title="Handover to delivery person"
          variant="brass"
          size="sm"
          loading={busy}
          disabled={disabled}
          onPress={onReady}
          style={{ marginTop: spacing.sm }}
        />
      )}
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
