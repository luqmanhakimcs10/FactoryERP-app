/**
 * The Floor Manager's "Collect [stage]" prompt.
 *
 * Raised when a Delivery Person hands a piece back (0056, step 7). There is no
 * notifications table behind it: the prompt IS the set of repeats sitting at
 * `awaiting_fm_collection`, read back by `fm_pending_collections`. That means it
 * cannot go stale or fire twice — if the state is gone, so is the prompt.
 *
 * Rendered as a banner pinned to the top of the order rather than a modal
 * dialog. A modal would have to be dismissed before the Floor Manager could
 * look at anything else on the order, and confirming receipt of a physical
 * piece is exactly the kind of thing someone needs to check the order for
 * first. It stays visible until acted on, which is the part that matters.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { AppButton } from './AppButton';
import { listPendingCollections, confirmCollection } from '../../api/endpoints/stageHandover';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  tint,
  elevation,
} from '../../constants/theme';

function stageLabel(stage: string | null | undefined) {
  if (!stage) return 'stage';
  const words = stage.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function CollectPrompt({ orderId }: { orderId?: string | null }) {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['pendingCollections', orderId ?? 'all'],
    queryFn: () => listPendingCollections(orderId),
    // Short window: the Delivery Person hands back on their own schedule, so
    // this is the one place in the app that genuinely benefits from polling.
    refetchInterval: 30_000,
  });

  const confirm = useMutation({
    mutationFn: (repeatId: string) => confirmCollection(repeatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pendingCollections'] });
      if (orderId) {
        queryClient.invalidateQueries({ queryKey: ['repeats', orderId] });
        queryClient.invalidateQueries({ queryKey: ['timeline', orderId] });
      }
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => setError(describeDbError(e, 'Collect')),
  });

  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <View style={styles.bell}>
          <Ionicons name="notifications" size={16} color={colors.indigoDeep} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {rows.length === 1
              ? 'A piece is back from the delivery person'
              : `${rows.length} pieces are back from the delivery person`}
          </Text>
          <Text style={styles.sub}>
            Confirm you have it and the next stage starts straight away.
          </Text>
        </View>
      </View>

      <View style={styles.stitch} />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {rows.map((r) => (
        <View key={r.repeat_id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.code}>{r.repeat_code}</Text>
            <Text style={styles.meta}>
              {r.order_code ? `${r.order_code} · ` : ''}Stage {r.stage_sequence ?? '—'} ·{' '}
              {stageLabel(r.stage_type)}
              {r.partner_name ? ` · back from ${r.partner_name}` : ''}
            </Text>
          </View>
          <AppButton
            title={`Collect ${stageLabel(r.stage_type)}`}
            variant="brass"
            size="sm"
            loading={confirm.isPending && confirm.variables === r.repeat_id}
            onPress={() => {
              setError(null);
              confirm.mutate(r.repeat_id);
            }}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: tint(colors.warning, 0.12),
    borderWidth: 1,
    borderColor: colors.warning,
    ...elevation.sm,
  },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  bell: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  sub: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  stitch: {
    marginVertical: spacing.md,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: colors.brass,
    opacity: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  meta: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
});

export default CollectPrompt;
