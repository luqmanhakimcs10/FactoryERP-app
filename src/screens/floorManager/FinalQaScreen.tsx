/**
 * Final QA + Invoice Prep (deferred from Phase 6).
 *
 * The queue reads repeats whose stages are all complete — from
 * repeat_stage_history's cache, the same source of truth used since Phase 3.
 *
 * THIS IS THE FIRST OF TWO FINAL GATES (0056). The Floor Manager's pass here no
 * longer completes a repeat: it moves it to `awaiting_qa_final` and sends it to
 * QA, whose own final pass is what completes it. An invoice still requires every
 * repeat `completed`, so an order cannot be billed until QA has signed it off —
 * that is deliberate, and it is why the counter below reports how many are
 * "through QA" rather than how many this screen has passed.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill, RepeatStatusPill } from '../../components/ui/StatusPill';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { getFinalQaQueue, finalQaPass, generateInvoice } from '../../api/endpoints/finance';
import { listRepeats } from '../../api/endpoints/orders';
import { getOrderJourney, type JourneyRow } from '../../api/endpoints/stageHandover';
import { uploadOrderPhoto, getPhotoUrls } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import { ROLE_LABEL, type Role } from '../../constants/roles';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  tint,
} from '../../constants/theme';

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Alert } = require('react-native');
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm', onPress: onConfirm },
  ]);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
export function FinalQaQueueScreen() {
  const navigation = useNavigation<any>();
  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['finalQaQueue'],
    queryFn: getFinalQaQueue,
  });

  return (
    <Screen padded={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.order_id}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            <Text style={styles.sectionTitle}>Repeats with every stage complete</Text>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? <Text style={styles.emptyBody}>{describeDbError(error, 'Queue')}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>Nothing awaiting final QA</Text>
              <Text style={styles.emptyBody}>
                Repeats appear here once they have cleared every finishing stage.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              navigation.navigate('FinalQaDetail', {
                orderId: item.order_id,
                orderCode: item.order_code,
              })
            }
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowTop}>
              <Text style={styles.code}>{item.order_code}</Text>
              <StatusPill label={`${item.ready_repeats} ready`} color={colors.indigo} />
            </View>
            <Text style={styles.vendor} numberOfLines={1}>
              {item.vendor_name}
            </Text>
            <Text style={styles.meta}>
              <Text style={styles.mono}>{item.ready_repeats}</Text> of{' '}
              <Text style={styles.mono}>{item.total_repeats}</Text> repeats awaiting final QA
            </Text>
            <Text style={styles.action}>Final QA →</Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Detail + invoice prep
// ---------------------------------------------------------------------------
export function FinalQaDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const orderId: string = route.params?.orderId;
  const orderCode: string | undefined = route.params?.orderCode;
  const { profile } = useAuth();

  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [invoicePhoto, setInvoicePhoto] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<{ invoice_code: string; amount: number } | null>(null);

  const { data: repeats, isLoading } = useQuery({
    queryKey: ['repeats', orderId],
    queryFn: () => listRepeats(orderId),
  });

  function invalidate() {
    for (const k of [
      'repeats', 'finalQaQueue', 'orders', 'order', 'invoices',
      'acctReceivableSummary', 'acctReceivableInvoices', 'acctClients',
    ]) {
      queryClient.invalidateQueries({ queryKey: [k] });
    }
  }

  const passMutation = useMutation({
    mutationFn: (repeatId: string) => finalQaPass(repeatId),
    onSuccess: invalidate,
    onError: (e) => setError(describeDbError(e, 'Final QA')),
  });

  const passAllMutation = useMutation({
    mutationFn: async () => {
      const pending = (repeats ?? []).filter((r) => r.current_status === 'awaiting_final_qa');
      for (const r of pending) await finalQaPass(r.id);
      return pending.length;
    },
    onSuccess: invalidate,
    onError: (e) => setError(describeDbError(e, 'Final QA')),
  });

  // An invoice is a money record, so it carries a photo like every other one:
  // fm_generate_invoice refuses without it.
  const invoiceMutation = useMutation({
    mutationFn: async () => {
      if (!invoicePhoto[0] || !profile?.factory_id) {
        throw new Error('Attach a photo of the invoice first.');
      }
      const photoPath = await uploadOrderPhoto(
        profile.factory_id, `inv-order-${orderId}`, invoicePhoto[0].uri, 'invoice'
      );
      return generateInvoice({
        orderId,
        photoUrl: photoPath,
        amount: amount.trim() ? Number(amount) : null,
        dueDate: dueDate.trim() || null,
      });
    },
    onSuccess: (inv) => {
      setInvoice({ invoice_code: inv.invoice_code, amount: Number(inv.amount) });
      invalidate();
    },
    onError: (e) => setError(describeDbError(e, 'Invoice')),
  });

  if (isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const rows = repeats ?? [];
  const pending = rows.filter((r) => r.current_status === 'awaiting_final_qa');
  // Passed here, now sitting with QA for the second gate.
  const withQa = rows.filter((r) => r.current_status === 'awaiting_qa_final');
  const done = rows.filter((r) => r.current_status === 'completed');
  const allDone = rows.length > 0 && done.length === rows.length;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.codeLarge}>{orderCode ?? 'Order'}</Text>
        <Text style={styles.meta}>
          <Text style={styles.mono}>{done.length}</Text> of{' '}
          <Text style={styles.mono}>{rows.length}</Text> repeats through QA
          {withQa.length > 0 ? ` · ${withQa.length} waiting on QA's final pass` : ''}
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {invoice ? (
          <ActionBanner
            tone="neutral"
            title={`Invoice ${invoice.invoice_code} raised`}
            subtitle={`${invoice.amount.toLocaleString()} — this order now appears in the accountant's Receivables list.`}
            style={styles.bannerGap}
          />
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* ---- Repeats ---- */}
        <Text style={styles.sectionTitleInline}>Repeats</Text>
        {rows.map((r) => (
          <View key={r.id} style={styles.repeatRow}>
            <Text style={styles.repeatCode}>{r.repeat_code}</Text>
            <View style={styles.repeatRight}>
              <RepeatStatusPill status={r.current_status} />
              {r.current_status === 'awaiting_final_qa' ? (
                <Pressable
                  onPress={() => {
                    setError(null);
                    passMutation.mutate(r.id);
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.passBtn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.passBtnText}>Pass</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}

        {pending.length > 0 ? (
          <AppButton
            title={`Pass all ${pending.length} remaining`}
            onPress={() =>
              confirmAction(
                'Pass final QA',
                `${pending.length} repeat(s) will be sent to QA for the final pass.`,
                () => {
                  setError(null);
                  passAllMutation.mutate();
                }
              )
            }
            loading={passAllMutation.isPending}
            style={{ marginTop: spacing.lg }}
          />
        ) : null}

        {/* ---- The whole journey (0084, Fix 7) ---- */}
        <OrderJourney orderId={orderId} />

        {/* ---- Invoice prep ---- */}
        <View style={styles.invoiceBlock}>
          <Text style={styles.sectionTitleInline}>Invoice prep</Text>
          {!allDone ? (
            <Text style={styles.gateNote}>
              Every repeat must pass final QA before an invoice can be raised —
              an invoice states the work is done.
            </Text>
          ) : (
            <>
              <Text style={styles.gateNote}>
                Leave the amount blank to bill from the order's own stitch count.
              </Text>
              <TextField
                label="Invoice amount (optional)"
                value={amount}
                onChangeText={setAmount}
                placeholder="Auto-calculated"
                numeric
                mono
              />
              <TextField
                label="Due date (optional)"
                value={dueDate}
                onChangeText={setDueDate}
                placeholder="YYYY-MM-DD — defaults to 30 days out"
                mono
              />
              <PhotoPicker
                label="Invoice photo (required)"
                hint="Attach the invoice document. No money record is created in this app without a photo."
                photos={invoicePhoto}
                onChange={setInvoicePhoto}
                multiple={false}
              />
              {invoicePhoto.length === 0 ? (
                <Text style={styles.gateNote}>
                  Attach the invoice photo to enable generating.
                </Text>
              ) : null}
            </>
          )}

          {!invoice ? (
            <AppButton
              title="Generate invoice"
              onPress={() => {
                setError(null);
                if (invoicePhoto.length === 0) {
                  setError('Attach a photo of the invoice — it is required.');
                  return;
                }
                if (dueDate.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate.trim())) {
                  setError('Enter the due date as YYYY-MM-DD, or leave it blank.');
                  return;
                }
                invoiceMutation.mutate();
              }}
              loading={invoiceMutation.isPending}
              disabled={!allDone || invoicePhoto.length === 0}
            />
          ) : (
            <AppButton
              title="Back to queue"
              variant="secondary"
              onPress={() => navigation.navigate('FinalQaQueue')}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// The whole journey (0084, Fix 7)
//
// Final QA used to be a pass/fail button over a list of repeat codes. Whoever
// pressed it could only see what they were approving by opening each repeat's
// History panel one at a time, on a different screen; anyone reviewing the order
// afterwards had no route at all.
//
// Nothing new is recorded for this. `repeat_stage_history` has held every event
// — status, stage, actor, partner, photo, note, handoff and return timestamps —
// since Phase 3. It was simply unreadable in one piece. `fm_order_journey`
// resolves the ids to names and returns the lot for one order, grouped here by
// repeat and then by stage so it reads as the sequence it actually was.
// ---------------------------------------------------------------------------

/** "clipping" -> "Clipping". */
function pretty(s: string | null | undefined): string {
  if (!s) return '';
  const w = s.replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Damage is the only failure a stage can record; everything else is progress. */
function toneFor(status: string): string {
  if (status === 'damaged') return colors.alert;
  if (status === 'completed') return colors.success;
  return colors.slate;
}

function OrderJourney({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['orderJourney', orderId],
    queryFn: () => getOrderJourney(orderId),
    enabled: open,
  });

  const rows = data ?? [];

  // One signed-URL round trip for the whole order rather than one per event.
  // The bucket is private, so a path is not renderable on its own.
  const paths = Array.from(
    new Set(rows.flatMap((r) => [r.photo_url, r.return_photo_url].filter(Boolean) as string[]))
  );
  const { data: urls } = useQuery({
    queryKey: ['journeyPhotos', orderId, paths.length],
    queryFn: () => getPhotoUrls(paths),
    enabled: open && paths.length > 0,
  });

  // repeat -> stage -> events, each preserving the order the RPC returned
  // (repeat_code, then created_at ascending).
  const byRepeat: { code: string; stages: { key: string; label: string; events: JourneyRow[] }[] }[] = [];
  for (const r of rows) {
    let rep = byRepeat.find((x) => x.code === r.repeat_code);
    if (!rep) {
      rep = { code: r.repeat_code, stages: [] };
      byRepeat.push(rep);
    }
    const key = r.stage_sequence == null ? 'final' : String(r.stage_sequence);
    let stage = rep.stages.find((s) => s.key === key);
    if (!stage) {
      stage = {
        key,
        label:
          r.stage_sequence == null
            ? 'Final QA & completion'
            : `Stage ${r.stage_sequence} · ${pretty(r.stage_type)}`,
        events: [],
      };
      rep.stages.push(stage);
    }
    stage.events.push(r);
  }

  return (
    <View style={styles.journeyBlock}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.journeyToggle}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitleInline}>Full journey</Text>
          <Text style={styles.journeyHint}>
            Every stage this order went through, who handled it, and the photos taken.
          </Text>
        </View>
        <Text style={styles.journeyChevron}>{open ? 'Hide' : 'Show'}</Text>
      </Pressable>

      {open ? (
        <View>
          {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
          {isError ? <Text style={styles.error}>{describeDbError(error, 'Journey')}</Text> : null}
          {!isLoading && rows.length === 0 ? (
            <Text style={styles.gateNote}>Nothing recorded for this order yet.</Text>
          ) : null}

          {byRepeat.map((rep) => (
            <View key={rep.code} style={styles.journeyRepeat}>
              <Text style={styles.journeyRepeatCode}>{rep.code}</Text>
              {rep.stages.map((stage) => (
                <View key={stage.key} style={styles.journeyStage}>
                  <Text style={styles.journeyStageLabel}>{stage.label}</Text>
                  {stage.events.map((e) => {
                    const photo = e.photo_url ? urls?.[e.photo_url] : null;
                    const returnPhoto = e.return_photo_url ? urls?.[e.return_photo_url] : null;
                    return (
                      <View key={e.history_id} style={styles.journeyEvent}>
                        <View style={[styles.journeyDot, { backgroundColor: toneFor(e.status) }]} />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.journeyStatus, { color: toneFor(e.status) }]}>
                            {pretty(e.status)}
                          </Text>
                          <Text style={styles.journeyMeta}>
                            {new Date(e.created_at).toLocaleString()}
                            {e.actor_name
                              ? ` · ${e.actor_name}${
                                  e.actor_role
                                    ? ` (${ROLE_LABEL[e.actor_role as Role] ?? e.actor_role})`
                                    : ''
                                }`
                              : ''}
                          </Text>
                          {e.partner_name ? (
                            <Text style={styles.journeyMeta}>Partner: {e.partner_name}</Text>
                          ) : null}
                          {e.handed_off_at ? (
                            <Text style={styles.journeyMeta}>
                              Out {new Date(e.handed_off_at).toLocaleString()}
                              {e.returned_at
                                ? ` · back ${new Date(e.returned_at).toLocaleString()}`
                                : ' · not back yet'}
                            </Text>
                          ) : null}
                          {e.note ? <Text style={styles.journeyNote}>{e.note}</Text> : null}
                          {photo || returnPhoto ? (
                            <View style={styles.journeyThumbs}>
                              {photo ? (
                                <Image source={{ uri: photo }} style={styles.journeyThumb} />
                              ) : null}
                              {returnPhoto ? (
                                <Image source={{ uri: returnPhoto }} style={styles.journeyThumb} />
                              ) : null}
                            </View>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionTitleInline: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep, fontWeight: fontWeight.medium },
  codeLarge: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  vendor: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  meta: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  action: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.brass, fontWeight: fontWeight.semibold },
  stitch: { marginVertical: spacing.lg },
  repeatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  repeatCode: { fontFamily: fontFamily.mono, fontSize: fontSize.secondary, color: colors.indigoDeep, flex: 1 },
  repeatRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  passBtn: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.brass,
  },
  passBtnText: { color: colors.indigoDeep, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  invoiceBlock: {
    marginTop: spacing.xxl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  gateNote: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20, marginBottom: spacing.md },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
  // ---- Full journey (0084) ----
  journeyBlock: {
    marginTop: spacing.xl,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  journeyToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  journeyHint: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  journeyChevron: { fontSize: fontSize.caption, color: colors.brass, fontWeight: fontWeight.semibold },
  journeyRepeat: { marginTop: spacing.lg },
  journeyRepeatCode: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  journeyStage: {
    marginTop: spacing.sm,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  journeyStageLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    textTransform: 'capitalize',
    marginBottom: spacing.xs,
  },
  journeyEvent: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingLeft: spacing.xs,
  },
  journeyDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  journeyStatus: { fontSize: fontSize.secondary, fontWeight: fontWeight.medium },
  journeyMeta: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 17 },
  journeyNote: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
  journeyThumbs: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  journeyThumb: {
    width: 64,
    height: 64,
    borderRadius: radius.sm,
    backgroundColor: tint(colors.slate, 0.1),
  },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  emptyBody: { paddingHorizontal: spacing.lg, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
