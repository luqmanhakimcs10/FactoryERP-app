/**
 * PO Detail + execution.
 *
 * Walks: execute → upload supplier bill → (owner approves, Phase 7 UI) →
 * (accountant pays, Phase 7 UI) → handover to store, which creates the GRN.
 *
 * The two middle steps render as READ-ONLY wait states here on purpose — the
 * approve/reject and payment actions belong to the Owner's Approvals Inbox and
 * the Accountant's Ledgers Home, both Phase 7. The transitions exist as RPCs so
 * the flow is complete and testable; this screen just doesn't offer them.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Image,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import { PO_STATUS_COLOR } from './PoQueueScreen';
import {
  getPurchaseOrder,
  executePo,
  uploadPoBill,
  handoverPoToStore,
} from '../../api/endpoints/inventory';
import { uploadOrderPhoto, getPhotoUrl } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import { PO_STATUS_LABEL } from '../../models/inventoryTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export function PoDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const poId: string = route.params?.poId;

  const [bill, setBill] = useState<LocalPhoto[]>([]);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: po, isLoading } = useQuery({
    queryKey: ['purchaseOrder', poId],
    queryFn: () => getPurchaseOrder(poId),
  });
  const { data: billUrl } = useQuery({
    queryKey: ['poBill', po?.bill_url],
    queryFn: () => getPhotoUrl(po!.bill_url as string),
    enabled: !!po?.bill_url,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['purchaseOrder', poId] });
    queryClient.invalidateQueries({ queryKey: ['purchaseOrders'] });
    queryClient.invalidateQueries({ queryKey: ['grns'] });
  }

  const executeMutation = useMutation({
    mutationFn: () => executePo(poId),
    onSuccess: invalidate,
    onError: (e) => setError(describeDbError(e, 'Purchase order')),
  });

  const billMutation = useMutation({
    mutationFn: async () => {
      if (!bill[0]) throw new Error('Attach the supplier bill first.');
      if (!profile?.factory_id) throw new Error('Your profile has no factory.');
      const path = await uploadOrderPhoto(profile.factory_id, `po-${poId}`, bill[0].uri, 'bill');
      const amt = amount.trim() ? Number(amount) : null;
      return uploadPoBill(poId, path, Number.isFinite(amt as number) ? amt : null);
    },
    onSuccess: () => {
      setBill([]);
      invalidate();
    },
    onError: (e) => setError(describeDbError(e, 'Supplier bill')),
  });

  const handoverMutation = useMutation({
    mutationFn: () => handoverPoToStore(poId),
    onSuccess: (grn) => {
      invalidate();
      setError(null);
      navigation.navigate('PoQueue');
      // Surfaced on the next screen; the GRN now sits in the store queue.
      console.log('GRN created:', grn.grn_code);
    },
    onError: (e) => setError(describeDbError(e, 'Handover')),
  });

  if (isLoading || !po) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const items = po.po_items ?? [];
  const busy = executeMutation.isPending || billMutation.isPending || handoverMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{po.po_code}</Text>
          <StatusPill label={PO_STATUS_LABEL[po.status]} color={PO_STATUS_COLOR[po.status]} />
        </View>
        <Text style={styles.supplier}>{po.suppliers?.name ?? 'No supplier assigned'}</Text>
        <Text style={styles.meta}>
          {po.auto_created
            ? `Raised automatically on thread shortfall${po.orders?.order_code ? ` for ${po.orders.order_code}` : ''}`
            : 'Raised manually by procurement'}
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* ---- Items ---- */}
        <Section title={`Items (${items.length})`}>
          <View style={styles.table}>
            <View style={styles.tableHeadRow}>
              <Text style={[styles.th, styles.colItem]}>Item</Text>
              <Text style={[styles.th, styles.colQty]}>Quantity</Text>
            </View>
            {items.map((it) => (
              <View key={it.id} style={styles.tableRow}>
                <Text style={[styles.td, styles.colItem, it.color_code ? styles.mono : null]}>
                  {it.color_code ?? it.description}
                </Text>
                <Text style={[styles.td, styles.colQty, styles.mono]}>
                  {Number(it.quantity_meters).toLocaleString()} m
                </Text>
              </View>
            ))}
          </View>
          {po.amount ? (
            <Text style={styles.amount}>
              Bill amount: <Text style={styles.mono}>{Number(po.amount).toLocaleString()}</Text>
            </Text>
          ) : null}
          {po.notes ? <Text style={styles.note}>{po.notes}</Text> : null}
        </Section>

        {/* ---- Lifecycle ---- */}
        <Section title="Progress">
          <Step label="Raised" done at={po.created_at} />
          <Step label="Executed with supplier" done={!!po.executed_at} at={po.executed_at} />
          <Step label="Supplier bill uploaded" done={!!po.bill_url} />
          <Step
            label="Owner approval"
            done={!!po.approved_at}
            at={po.approved_at}
            waiting={po.status === 'awaiting_approval'}
            waitingNote="Waiting on the owner's Approvals Inbox"
          />
          <Step
            label="Accountant payment"
            done={!!po.paid_at}
            at={po.paid_at}
            waiting={po.status === 'approved'}
            waitingNote="Waiting on the accountant's Payables ledger"
          />
          <Step label="Handed over to store" done={['handed_over', 'received'].includes(po.status)} />
          <Step label="Receipt confirmed by store" done={po.status === 'received'} />
        </Section>

        {/* ---- Actions, gated to procurement's own steps ---- */}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {po.status === 'auto_generated' || po.status === 'draft' ? (
          <AppButton
            title="Execute with supplier"
            onPress={() => {
              setError(null);
              executeMutation.mutate();
            }}
            loading={executeMutation.isPending}
            disabled={busy}
          />
        ) : null}

        {po.status === 'executed' ? (
          <Section title="Upload supplier bill">
            <PhotoPicker
              label="Supplier bill"
              hint="Attach the bill; the PO then goes to the owner for approval."
              photos={bill}
              onChange={setBill}
              multiple={false}
            />
            <TextField
              label="Bill amount (optional)"
              value={amount}
              onChangeText={setAmount}
              placeholder="42500"
              numeric
              mono
            />
            <AppButton
              title="Upload bill & send for approval"
              onPress={() => {
                setError(null);
                if (!bill[0]) {
                  setError('Attach the supplier bill first.');
                  return;
                }
                billMutation.mutate();
              }}
              loading={billMutation.isPending}
              disabled={busy}
            />
          </Section>
        ) : null}

        {po.status === 'awaiting_approval' || po.status === 'approved' ? (
          <ActionBanner
            title={
              po.status === 'awaiting_approval'
                ? 'Waiting on owner approval'
                : 'Approved — waiting on accountant payment'
            }
            subtitle={`Nothing to do here. This step is actioned from the ${
              po.status === 'awaiting_approval'
                ? "owner's Approvals Inbox"
                : "accountant's Payables ledger"
            }.`}
            style={styles.bannerGap}
          />
        ) : null}

        {po.status === 'paid' ? (
          <AppButton
            title="Confirm handover to store manager"
            onPress={() => {
              setError(null);
              handoverMutation.mutate();
            }}
            loading={handoverMutation.isPending}
            disabled={busy}
          />
        ) : null}

        {po.status === 'handed_over' ? (
          <ActionBanner
            title="Handed over"
            subtitle="A GRN is in the store manager's queue. Stock rises only once they confirm physical receipt."
            style={styles.bannerGap}
          />
        ) : null}

        {po.status === 'received' ? (
          <ActionBanner
            tone="neutral"
            title="Received into stock"
            subtitle="The store manager confirmed receipt and thread stock has been updated."
            style={styles.bannerGap}
          />
        ) : null}

        {/* ---- Bill preview ---- */}
        {billUrl ? (
          <Section title="Supplier bill">
            <Image source={{ uri: billUrl }} style={styles.bill} resizeMode="contain" />
          </Section>
        ) : null}

        {/* ---- Printable view ---- */}
        {Platform.OS === 'web' ? (
          <AppButton
            title="Print / save as PDF"
            variant="secondary"
            onPress={() => {
              if (typeof window !== 'undefined') window.print();
            }}
            style={{ marginTop: spacing.lg }}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function Step({
  label,
  done,
  at,
  waiting,
  waitingNote,
}: {
  label: string;
  done?: boolean;
  at?: string | null;
  waiting?: boolean;
  waitingNote?: string;
}) {
  return (
    <View style={styles.step}>
      <View
        style={[
          styles.stepDot,
          done && { backgroundColor: colors.success, borderColor: colors.success },
          waiting && { backgroundColor: colors.warning, borderColor: colors.warning },
        ]}
      />
      <View style={{ flex: 1 }}>
        <Text style={[styles.stepLabel, done && { color: colors.indigoDeep }]}>{label}</Text>
        <Text style={styles.stepState}>
          {done ? `Done${at ? ` · ${new Date(at).toLocaleDateString()}` : ''}` : waiting ? 'Waiting' : 'Not started'}
        </Text>
        {waiting && waitingNote ? <Text style={styles.stepNote}>{waitingNote}</Text> : null}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  supplier: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.indigoDeep },
  meta: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  stitch: { marginVertical: spacing.lg },
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  tableHeadRow: { flexDirection: 'row', backgroundColor: colors.indigo, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  th: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  tableRow: { flexDirection: 'row', paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  td: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  colItem: { flex: 1 },
  colQty: { width: 110, textAlign: 'right' },
  mono: { fontFamily: fontFamily.mono },
  amount: { marginTop: spacing.sm, fontSize: fontSize.secondary, color: colors.indigoDeep },
  note: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic' },
  step: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md, alignItems: 'flex-start' },
  stepDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: 'transparent',
    marginTop: 3,
  },
  stepLabel: { fontSize: fontSize.secondary, color: colors.slate, fontWeight: fontWeight.medium },
  stepState: { fontSize: fontSize.caption, color: colors.slate },
  stepNote: { marginTop: 2, fontSize: fontSize.caption, color: colors.warning },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
  bill: {
    width: '100%',
    height: 280,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
});
