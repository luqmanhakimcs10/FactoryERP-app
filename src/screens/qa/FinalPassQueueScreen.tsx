/**
 * QA — Final pass. The SECOND of the two final gates (Fix 5).
 *
 * The Floor Manager's Final QA sends a repeat here; this is the pass that
 * actually completes it. Two roles, two gates, deliberately: `fm_final_qa_pass`
 * lands on `awaiting_qa_final` and only `qa_final_pass` reaches `completed`, so
 * neither role can sign a piece off alone.
 *
 * There is no reject action here on purpose — rejecting is "Mark damage", which
 * already exists on the stage-tracking table and writes a damage record with a
 * reason and a responsible party. A bare "reject" button that only moved a
 * status backwards would lose all of that.
 *
 * Passing requires a PHOTO of the finished product. This is the last look
 * anyone takes at the piece before it is invoiced and delivered, so it is the
 * worst place in the app to have no record of what was approved. The
 * requirement lives in `qa_final_pass` itself, not just here.
 */
import React from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { StatusPill } from '../../components/ui/StatusPill';
import { EmptyState, ListSkeleton } from '../../components/ui/States';
import { listQaFinalQueue, qaFinalPass } from '../../api/endpoints/stageHandover';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  elevation,
} from '../../constants/theme';

export function FinalPassQueueScreen() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const [error, setError] = React.useState<string | null>(null);
  // Which row is mid-capture, and the photo taken for it.
  const [capturingId, setCapturingId] = React.useState<string | null>(null);
  const [photo, setPhoto] = React.useState<LocalPhoto[]>([]);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['qaFinalQueue'],
    queryFn: listQaFinalQueue,
  });

  const pass = useMutation({
    mutationFn: async (row: { repeat_id: string; order_id: string }) => {
      if (!photo[0]) throw new Error('Take a photo of the finished product first.');
      const url = await uploadOrderPhoto(
        profile?.factory_id ?? '',
        row.order_id,
        photo[0].uri,
        'final-qa'
      );
      return qaFinalPass(row.repeat_id, url);
    },
    onSuccess: () => {
      setCapturingId(null);
      setPhoto([]);
      queryClient.invalidateQueries({ queryKey: ['qaFinalQueue'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
    },
    onError: (e) => setError(describeDbError(e, 'Final pass')),
  });

  if (isLoading) {
    return (
      <Screen padded={false}>
        <ListSkeleton rows={3} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <View style={styles.head}>
        <Text style={styles.title}>Final pass</Text>
        <Text style={styles.sub}>
          Cleared by the Floor Manager's Final QA. Passing here completes the piece and, once
          every piece on an order is through, marks the order ready for delivery.
        </Text>
        <View style={styles.stitch} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.repeat_id}
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          <EmptyState
            icon="checkmark-done-outline"
            title="Nothing waiting on a final pass"
            message="Pieces arrive here once the Floor Manager has done their Final QA check."
          />
        }
        renderItem={({ item }) => {
          const capturing = capturingId === item.repeat_id;
          return (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={styles.code}>{item.repeat_code}</Text>
                  <Text style={styles.meta}>
                    {item.order_code} · {item.vendor_name}
                  </Text>
                  <Text style={styles.meta}>
                    Sheet {item.sheet_number ?? '—'}
                    {item.color_assignment ? ` · ${item.color_assignment}` : ''}
                  </Text>
                  <View style={{ flexDirection: 'row', marginTop: spacing.xs }}>
                    <StatusPill label="Awaiting final pass" color={colors.indigo} />
                  </View>
                </View>
                {!capturing ? (
                  <AppButton
                    title="Pass"
                    variant="brass"
                    size="sm"
                    disabled={pass.isPending}
                    onPress={() => {
                      setError(null);
                      setPhoto([]);
                      setCapturingId(item.repeat_id);
                    }}
                  />
                ) : null}
              </View>

              {capturing ? (
                <View style={styles.captureBox}>
                  <PhotoPicker
                    label="Photo of the finished product"
                    hint="Required — the record of what was approved before invoicing and delivery."
                    photos={photo}
                    onChange={setPhoto}
                    multiple={false}
                    retakeLabel="Retake"
                  />
                  <View style={styles.captureActions}>
                    <AppButton
                      title="Cancel"
                      variant="secondary"
                      disabled={pass.isPending}
                      onPress={() => {
                        setCapturingId(null);
                        setPhoto([]);
                        setError(null);
                      }}
                      style={{ flex: 1 }}
                    />
                    <AppButton
                      title="Confirm pass"
                      variant="brass"
                      disabled={!photo[0]}
                      loading={pass.isPending}
                      onPress={() => pass.mutate({ repeat_id: item.repeat_id, order_id: item.order_id })}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  sub: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  stitch: {
    marginTop: spacing.md,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: colors.brass,
    opacity: 0.5,
  },
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...elevation.sm,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  captureBox: { marginTop: spacing.md },
  captureActions: { flexDirection: 'row', gap: spacing.sm },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  error: { paddingHorizontal: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
});

export default FinalPassQueueScreen;
