/**
 * Floor Manager — Repeats & stage tracking (Stage 9).
 *
 * FM previously had no route to this data at all (only QA's `OrderQa` screen
 * had it, and that screen also renders QA-only tabs FM shouldn't see). This is
 * a thin wrapper around the same shared `StageTrackingTable` QA uses, so both
 * roles see identical status data — the QA-only actions inside that table are
 * still gated by role, not by which screen it's rendered from.
 */
import React from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { OrderStatusPill } from '../../components/ui/StatusPill';
import { StageTrackingTable } from '../../components/ui/StageTrackingTable';
import { CollectPrompt } from '../../components/ui/CollectPrompt';
import { AppButton } from '../../components/ui/AppButton';
import { listStrandedOrders, adoptStrandedRepeats } from '../../api/endpoints/stageHandover';
import { getOrder, listRepeats, listOrderStages } from '../../api/endpoints/orders';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily, tint } from '../../constants/theme';

export function StageTrackingScreen() {
  const route = useRoute<any>();
  const orderId: string = route.params?.orderId;

  const { data: order, isLoading } = useQuery({ queryKey: ['order', orderId], queryFn: () => getOrder(orderId) });
  const { data: repeats } = useQuery({ queryKey: ['repeats', orderId], queryFn: () => listRepeats(orderId) });
  const { data: stages } = useQuery({ queryKey: ['orderStages', orderId], queryFn: () => listOrderStages(orderId) });

  // Repeats coded for this order but left outside the stage loop. Should always
  // be empty since 0063 retired the second pipeline that caused it; the control
  // exists so that if it ever happens again the Floor Manager can fix it
  // themselves rather than needing a migration.
  const queryClient = useQueryClient();
  const [adoptError, setAdoptError] = React.useState<string | null>(null);
  const { data: stranded } = useQuery({ queryKey: ['strandedOrders'], queryFn: listStrandedOrders });
  const mine = (stranded ?? []).find((s) => s.order_id === orderId);

  const adopt = useMutation({
    mutationFn: () => adoptStrandedRepeats(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repeats', orderId] });
      queryClient.invalidateQueries({ queryKey: ['strandedOrders'] });
      queryClient.invalidateQueries({ queryKey: ['timeline', orderId] });
    },
    onError: (e) => setAdoptError(describeDbError(e, 'Adopt repeats')),
  });

  if (isLoading || !order) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <Text style={styles.code}>{order.order_code}</Text>
          <OrderStatusPill status={order.status} />
        </View>
        <Text style={styles.vendor}>{order.vendors?.name}</Text>

        {/* The "Collect [stage]" prompt the delivery person raises by handing
            back. Scoped to this order so it can't nag about other work. */}
        <CollectPrompt orderId={orderId} />

        {mine ? (
          <View style={styles.strandedCard}>
            <Text style={styles.strandedTitle}>
              {mine.stranded} repeat{mine.stranded === 1 ? '' : 's'} on this order never entered the
              stage loop
            </Text>
            <Text style={styles.strandedBody}>
              They were coded, but the order moved past machine selection without them, so nothing
              can advance them. Adopting starts them at the first stage.
            </Text>
            {adoptError ? <Text style={styles.strandedError}>{adoptError}</Text> : null}
            <AppButton
              title={`Bring ${mine.stranded} repeat${mine.stranded === 1 ? '' : 's'} into production`}
              variant="brass"
              size="sm"
              loading={adopt.isPending}
              onPress={() => {
                setAdoptError(null);
                adopt.mutate();
              }}
              style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }}
            />
          </View>
        ) : null}

        {repeats?.length ? (
          <StageTrackingTable
            orderId={orderId}
            factoryId={order.factory_id}
            repeats={repeats}
            stages={stages ?? []}
          />
        ) : (
          <Text style={styles.body}>No repeats coded yet.</Text>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { marginTop: spacing.xs, marginBottom: spacing.lg, fontSize: fontSize.body, color: colors.indigoDeep },
  body: { fontSize: fontSize.secondary, color: colors.slate },
  strandedCard: {
    marginBottom: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: tint(colors.warning, 0.1),
  },
  strandedTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  strandedBody: { marginTop: 4, fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  strandedError: { marginTop: spacing.sm, fontSize: fontSize.caption, color: colors.alert },
});

export default StageTrackingScreen;
