/**
 * Order QA — the screen a QA user lands on for a single order once cloth is
 * accepted (status `awaiting_coding`).
 *
 * Four tabs: Repeat QA (the piece-by-piece pass/reject gate — see
 * StartQaModal and migration 0034), Job card (read-only preview; the floor
 * manager still owns building it), Repeats & stage tracking, and Damage
 * records.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { AppButton } from '../../components/ui/AppButton';
import { StageProgress } from '../../components/ui/StageProgress';
import { StatusPill, OrderStatusPill } from '../../components/ui/StatusPill';
import { StageTrackingTable } from '../../components/ui/StageTrackingTable';
import { StartQaModal } from './StartQaModal';
import {
  getOrder,
  listSheets,
  listRepeats,
  listOrderDamage,
  listOrderStages,
  getJobCard,
  getOrderTimeline,
  completeRepeatQa,
} from '../../api/endpoints/orders';
import { writeOffPiece } from '../../api/endpoints/stageHandover';
import { describeDbError } from '../../utils/errors';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import type { Sheet, Repeat, DamageRecord } from '../../models/orderTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

const RESPONSIBLE_COLOR: Record<string, string> = {
  vendor: colors.accountVendor,
  worker: colors.accountWorker,
  partner: colors.accountPartner,
};

type TabKey = 'repeat_qa' | 'job_card' | 'stage_tracking' | 'damage';

/**
 * A rejected piece is NOT resolved — it is mid-round-trip (0059):
 *   returned  -> with the Order Taker, going back to the vendor
 *   recheck   -> the vendor sent it back; QA has to inspect it again
 * Only `passed` clears a slot. `pending` is a slot nobody has looked at yet.
 */
type Piece =
  | { status: 'passed'; index: number; total: number; repeat: Repeat }
  | { status: 'returned'; index: number; total: number; damage: DamageRecord }
  | { status: 'recheck'; index: number; total: number; damage: DamageRecord }
  /** Slot closed with no piece behind it — the vendor never sent it back. */
  | { status: 'written_off'; index: number; total: number; damage: DamageRecord }
  | { status: 'pending'; index: number; total: number };

/**
 * One sheet's repeats_count slots.
 *
 * Damage rows in `passed` / `superseded` are skipped: the first produced the
 * coded repeat that is already in this list, and the second handed its slot to
 * a replacement row. Counting either would show a sheet as having more physical
 * pieces than it does.
 */
function piecesForSheet(sheet: Sheet, repeats: Repeat[], damage: DamageRecord[]): Piece[] {
  const passed = repeats
    .filter((r) => r.sheet_id === sheet.id)
    .sort((a, b) => a.repeat_number - b.repeat_number)
    .map((repeat) => ({ status: 'passed' as const, at: repeat.created_at, repeat }));

  const open = damage
    .filter(
      (d) =>
        d.sheet_id === sheet.id &&
        d.repeat_id === null &&
        d.stage_type === 'repeat_qa' &&
        ['awaiting_return', 'awaiting_recheck', 'written_off'].includes(
          d.recheck_state ?? 'awaiting_return'
        )
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((d) => ({
      status: (d.recheck_state === 'written_off'
        ? 'written_off'
        : d.recheck_state === 'awaiting_recheck'
          ? 'recheck'
          : 'returned') as 'recheck' | 'returned' | 'written_off',
      at: d.created_at,
      damage: d,
    }));

  const held = [...passed, ...open].sort((a, b) => a.at.localeCompare(b.at));
  const pieces: Piece[] = held.map((r, i) =>
    r.status === 'passed'
      ? { status: 'passed', index: i + 1, total: sheet.repeats_count, repeat: r.repeat }
      : { status: r.status, index: i + 1, total: sheet.repeats_count, damage: r.damage } as Piece
  );
  for (let i = held.length; i < sheet.repeats_count; i++) {
    pieces.push({ status: 'pending', index: i + 1, total: sheet.repeats_count });
  }
  return pieces;
}

export function OrderQaScreen() {
  const route = useRoute<any>();
  const queryClient = useQueryClient();
  const orderId: string = route.params?.orderId;

  const [activeTab, setActiveTab] = useState<TabKey>('repeat_qa');
  // `damageId` present => this is a re-inspection of a returned piece.
  const [startQaTarget, setStartQaTarget] = useState<
    { sheet: Sheet; index: number; total: number; damageId?: string } | null
  >(null);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const { data: order, isLoading } = useQuery({ queryKey: ['order', orderId], queryFn: () => getOrder(orderId) });
  const { data: sheets } = useQuery({ queryKey: ['sheets', orderId], queryFn: () => listSheets(orderId) });
  const { data: repeats } = useQuery({ queryKey: ['repeats', orderId], queryFn: () => listRepeats(orderId) });
  const { data: damage } = useQuery({ queryKey: ['damage', orderId], queryFn: () => listOrderDamage(orderId) });
  const { data: stages } = useQuery({ queryKey: ['orderStages', orderId], queryFn: () => listOrderStages(orderId) });
  const { data: jobCard } = useQuery({ queryKey: ['jobCard', orderId], queryFn: () => getJobCard(orderId) });
  const { data: timeline } = useQuery({ queryKey: ['timeline', orderId], queryFn: () => getOrderTimeline(orderId) });

  const bySheet = useMemo(() => {
    if (!sheets) return [];
    return sheets.map((sheet) => ({ sheet, pieces: piecesForSheet(sheet, repeats ?? [], damage ?? []) }));
  }, [sheets, repeats, damage]);

  const totalPieces = bySheet.reduce((n, s) => n + s.pieces.length, 0);
  const unresolved = bySheet.reduce((n, s) => n + s.pieces.filter((p) => p.status === 'pending').length, 0);
  // Pieces still going round the reject/return loop. These are what block the
  // job card — the old rule counted a rejection as "done" and let an order with
  // nothing usable on it walk straight into production.
  const outstanding = bySheet.reduce(
    (n, s) => n + s.pieces.filter((p) => p.status === 'returned' || p.status === 'recheck').length,
    0
  );
  const writtenOff = bySheet.reduce(
    (n, s) => n + s.pieces.filter((p) => p.status === 'written_off').length,
    0
  );
  const passedCount = bySheet.reduce(
    (n, s) => n + s.pieces.filter((p) => p.status === 'passed').length,
    0
  );
  const awaitingRecheck = bySheet.reduce(
    (n, s) => n + s.pieces.filter((p) => p.status === 'recheck').length,
    0
  );
  const canInspect = order?.status === 'awaiting_coding';
  const allPassed = totalPieces > 0 && unresolved === 0 && outstanding === 0;

  /**
   * The escape hatch. A vendor who never sends a rejected piece back would
   * otherwise hold the order at `awaiting_coding` forever — 0059 gave the piece
   * a return loop but nothing ever ended it. Writing off closes the slot with
   * no repeat behind it; the damage record stays exactly as it was, because
   * this is an admission the piece is gone, not a retraction of who lost it.
   */
  const writeOff = useMutation({
    mutationFn: (damageId: string) => writeOffPiece(damageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['damage', orderId] });
      queryClient.invalidateQueries({ queryKey: ['returnRepeats'] });
      queryClient.invalidateQueries({ queryKey: ['queueSummary'] });
    },
    onError: (e) => setCompleteError(describeDbError(e, 'Write off')),
  });

  const completeMutation = useMutation({
    mutationFn: () => completeRepeatQa(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order', orderId] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      setActiveTab('job_card');
    },
    onError: (e) => setCompleteError(describeDbError(e, 'Repeat QA')),
  });

  if (isLoading || !order) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const card = jobCard?.card ?? null;
  const lines = jobCard?.lines ?? [];

  return (
    <Screen padded={false}>
      <View style={styles.head}>
        <Text style={styles.code}>{order.order_code}</Text>
        <OrderStatusPill status={order.status} />
      </View>
      <Text style={styles.vendor}>{order.vendors?.name}</Text>

      <SegmentedTabs
        value={activeTab}
        onChange={setActiveTab}
        tabs={[
          { key: 'repeat_qa', label: `Repeat QA${unresolved ? ` (${unresolved} pending)` : ''}` },
          { key: 'job_card', label: 'Job card' },
          { key: 'stage_tracking', label: 'Repeats & stage tracking' },
          { key: 'damage', label: `Damage records${damage?.length ? ` (${damage.length})` : ''}` },
        ]}
      />

      {activeTab === 'repeat_qa' ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.repeatQaHead}>
            <Text style={styles.sectionTitle}>Repeat QA</Text>
            <AppButton
              title="Continue to job card"
              onPress={() => {
                setCompleteError(null);
                completeMutation.mutate();
              }}
              disabled={!canInspect || !allPassed || completeMutation.isPending}
              loading={completeMutation.isPending}
            />
          </View>

          {canInspect ? (
            <Text style={styles.progressNote}>
              {unresolved > 0
                ? `${unresolved} of ${totalPieces} piece${totalPieces === 1 ? '' : 's'} still awaiting a first decision.`
                : awaitingRecheck > 0
                  ? `${awaitingRecheck} piece${awaitingRecheck === 1 ? ' is' : 's are'} back from the vendor and needs re-inspecting before this order can move on.`
                  : outstanding > 0
                    ? `${outstanding} rejected piece${outstanding === 1 ? ' is' : 's are'} with the order taker, going back to the vendor. This order can move on once ${outstanding === 1 ? 'it comes' : 'they come'} back and passes QA.`
                    : passedCount === 0
                      ? `Every piece has been written off — there is nothing to produce. This order should be cancelled rather than sent to the floor.`
                      : `${passedCount} of ${totalPieces} piece${totalPieces === 1 ? '' : 's'} passed${
                          writtenOff > 0 ? `, ${writtenOff} written off` : ''
                        }.`}
            </Text>
          ) : (
            <Text style={styles.progressNote}>
              Repeat QA is complete — this order has moved on to the job card.
            </Text>
          )}
          {completeError ? <Text style={styles.error}>{completeError}</Text> : null}

          <View style={styles.table}>
            <View style={styles.tableHeadRow}>
              <Text style={[styles.th, styles.colPiece]}>Piece</Text>
              <Text style={[styles.th, styles.colStatus]}>Status</Text>
              <Text style={[styles.th, styles.colActions]}>Actions</Text>
            </View>
            {bySheet.map(({ sheet, pieces }) =>
              pieces.map((piece) => (
                <View key={`${sheet.id}-${piece.index}`} style={styles.tableRow}>
                  <View style={styles.colPiece}>
                    <Text style={styles.pieceTitle}>
                      {sheet.color_assignment} — piece {piece.index} of {piece.total}
                    </Text>
                    <Text style={styles.pieceSubtitle}>
                      {order.order_code}-S{sheet.sheet_number}
                    </Text>
                  </View>
                  <View style={styles.colStatus}>
                    {piece.status === 'passed' ? (
                      <StatusPill label={`Passed — ${piece.repeat.repeat_code}`} color={colors.success} />
                    ) : piece.status === 'returned' ? (
                      <StatusPill
                        label={`Returned to vendor — ${DAMAGE_TYPE_LABEL[piece.damage.damage_type] ?? piece.damage.damage_type}`}
                        color={colors.alert}
                      />
                    ) : piece.status === 'recheck' ? (
                      <StatusPill label="Back from vendor — re-inspect" color={colors.warning} />
                    ) : piece.status === 'written_off' ? (
                      <StatusPill label="Written off — never returned" color={colors.slate} />
                    ) : (
                      <Text style={styles.pending}>Awaiting inspection</Text>
                    )}
                  </View>
                  <View style={styles.colActions}>
                    {piece.status === 'pending' && canInspect ? (
                      <AppButton
                        title="Start QA"
                        variant="brass"
                        onPress={() => setStartQaTarget({ sheet, index: piece.index, total: piece.total })}
                        style={styles.startBtn}
                      />
                    ) : piece.status === 'recheck' && canInspect ? (
                      <AppButton
                        title="Re-inspect"
                        variant="brass"
                        onPress={() =>
                          setStartQaTarget({
                            sheet,
                            index: piece.index,
                            total: piece.total,
                            damageId: piece.damage.id,
                          })
                        }
                        style={styles.startBtn}
                      />
                    ) : piece.status === 'returned' && canInspect ? (
                      <View style={{ alignItems: 'flex-end', gap: 4 }}>
                        <Text style={styles.waiting}>With order taker</Text>
                        <AppButton
                          title="Write off"
                          variant="secondary"
                          size="sm"
                          loading={writeOff.isPending && writeOff.variables === piece.damage.id}
                          onPress={() => {
                            setCompleteError(null);
                            writeOff.mutate(piece.damage.id);
                          }}
                        />
                      </View>
                    ) : (
                      <Text style={styles.dash}>—</Text>
                    )}
                  </View>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      ) : null}

      {activeTab === 'job_card' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {!stages?.length ? (
            <Text style={styles.body}>Not started yet — the floor manager sets the stage sequence first.</Text>
          ) : (
            <>
              <StatusPill
                label={
                  card
                    ? `${card.status === 'draft' ? 'Draft' : card.status === 'shared' ? 'Shared' : 'Confirmed'} · rev ${card.revision}`
                    : 'Not generated'
                }
                color={card?.status === 'confirmed' ? colors.success : card?.status === 'shared' ? colors.brass : colors.slate}
              />
              {lines.length ? (
                <View style={[styles.table, { marginTop: spacing.md }]}>
                  <View style={styles.tableHeadRow}>
                    <Text style={[styles.th, styles.colNeedle]}>Needle</Text>
                    <Text style={[styles.th, styles.colColor]}>Thread colour</Text>
                    <Text style={[styles.th, styles.colStitch]}>Stitches</Text>
                  </View>
                  {lines.map((l) => (
                    <View key={l.id} style={styles.tableRow}>
                      <Text style={[styles.td, styles.mono, styles.colNeedle]}>{String(l.needle_number).padStart(2, '0')}</Text>
                      <Text style={[styles.td, styles.mono, styles.colColor]}>{l.thread_color_code}</Text>
                      <Text style={[styles.td, styles.mono, styles.colStitch]}>{l.stitch_count?.toLocaleString() ?? '—'}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[styles.body, { marginTop: spacing.md }]}>No job card generated yet.</Text>
              )}
              <Text style={styles.readOnlyNote}>
                Building and sharing the job card is done by the floor manager.
              </Text>
            </>
          )}
        </ScrollView>
      ) : null}

      {activeTab === 'stage_tracking' ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.sectionTitle}>Repeats & stage tracking ({repeats?.length ?? 0})</Text>
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

          <Text style={[styles.sectionTitle, { marginTop: spacing.xl }]}>Progress</Text>
          {timeline?.length ? (
            <StageProgress steps={timeline} orientation="vertical" />
          ) : (
            <Text style={styles.body}>No progress recorded yet.</Text>
          )}
        </ScrollView>
      ) : null}

      {activeTab === 'damage' ? (
        <ScrollView contentContainerStyle={styles.content}>
          {damage?.length ? (
            damage.map((d) => (
              <View key={d.id} style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{DAMAGE_TYPE_LABEL[d.damage_type] ?? d.damage_type}</Text>
                  <StatusPill
                    label={`${d.responsible_type} accountable`}
                    color={RESPONSIBLE_COLOR[d.responsible_type] ?? colors.slate}
                  />
                </View>
                <Text style={styles.cardLine}>
                  Stage: {d.stage_type.replace(/_/g, ' ')}
                  {d.sheets ? ` · Sheet ${d.sheets.sheet_number}` : ''}
                  {d.repeats ? ` · ${d.repeats.repeat_code}` : ''}
                </Text>
                {d.note ? <Text style={styles.cardLine}>{d.note}</Text> : null}
              </View>
            ))
          ) : (
            <Text style={styles.body}>None recorded.</Text>
          )}
        </ScrollView>
      ) : null}

      {startQaTarget ? (
        <StartQaModal
          visible
          order={order}
          sheet={startQaTarget.sheet}
          pieceIndex={startQaTarget.index}
          pieceTotal={startQaTarget.total}
          recheckDamageId={startQaTarget.damageId ?? null}
          onClose={() => setStartQaTarget(null)}
          onResolved={() => setStartQaTarget(null)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { paddingHorizontal: spacing.lg, marginTop: spacing.xs, fontSize: fontSize.body, color: colors.indigoDeep },
  content: { padding: spacing.xl },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  repeatQaHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.sm },
  progressNote: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.md },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.md },
  body: { fontSize: fontSize.secondary, color: colors.slate },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  tableHeadRow: { flexDirection: 'row', backgroundColor: colors.indigo, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  th: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  td: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  colPiece: { flex: 2 },
  colStatus: { flex: 2 },
  colActions: { flex: 1, alignItems: 'flex-end' },
  colNeedle: { width: 70 },
  colColor: { flex: 1 },
  colStitch: { width: 90, textAlign: 'right' },
  pieceTitle: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  pieceSubtitle: { marginTop: 2, fontSize: fontSize.caption, fontFamily: fontFamily.mono, color: colors.slate },
  waiting: { fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
  pending: { fontSize: fontSize.caption, color: colors.slate },
  dash: { fontSize: fontSize.body, color: colors.slate },
  startBtn: { minHeight: 36, paddingHorizontal: spacing.md },
  mono: { fontFamily: fontFamily.mono },
  codeGrid: { gap: spacing.sm },
  codeChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  codeChipText: { fontFamily: fontFamily.mono, fontSize: fontSize.secondary, color: colors.indigoDeep },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: 4 },
  cardTitle: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep, flexShrink: 1 },
  cardLine: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  readOnlyNote: { marginTop: spacing.lg, fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
});

export default OrderQaScreen;
