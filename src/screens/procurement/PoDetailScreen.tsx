/**
 * PO detail — three statuses, two owners.
 *
 *   Creation ──▶ Procured ──▶ Paid ──▶ (Received)
 *   store manager       accountant      store manager
 *
 * The owner-approval step is gone (0089), not hidden: `po_owner_approve` was
 * dropped, and so were `po_execute`, `po_upload_bill` and `po_handover_to_store`.
 * This screen therefore offers exactly ONE transition — "Procured", to the store
 * manager — and shows everything else as state.
 *
 * Procurement reaches the same screen with no transition at all. Their verbs are
 * view, save and download, so the export button is what they get.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import { poStatusColor } from './PoQueueScreen';
import { getPurchaseOrder, markPoProcured } from '../../api/endpoints/inventory';
import { getPhotoUrl } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import { sharePoPdf } from '../../utils/poExport';
import { ROLES } from '../../constants/roles';
import { PO_STATUS_LABEL, PO_FLOW, poFlowStep } from '../../models/inventoryTypes';
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
  const queryClient = useQueryClient();
  const { role } = useAuth();
  const poId: string = route.params?.poId;

  const [error, setError] = useState<string | null>(null);
  const [confirmProcured, setConfirmProcured] = useState(false);
  const [exporting, setExporting] = useState(false);

  const { data: po, isLoading } = useQuery({
    queryKey: ['purchaseOrder', poId],
    queryFn: () => getPurchaseOrder(poId),
  });
  const { data: billUrl } = useQuery({
    queryKey: ['poBill', po?.bill_url],
    queryFn: () => getPhotoUrl(po!.bill_url as string),
    enabled: !!po?.bill_url,
  });

  const procured = useMutation({
    mutationFn: () => markPoProcured(poId),
    onSuccess: () => {
      for (const k of ['purchaseOrder', 'purchaseOrders', 'smPos', 'procurementPos', 'queueSummary']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
      setConfirmProcured(false);
      setError(null);
    },
    onError: (e) => setError(describeDbError(e, 'Purchase order')),
  });

  if (isLoading || !po) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const items = po.po_items ?? [];
  const step = poFlowStep(po.status);
  const canProcure =
    (role === ROLES.STORE_MANAGER || role === ROLES.COMPANY_ADMIN) &&
    (po.status === 'auto_generated' || po.status === 'draft');

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.head}>
          <Text style={styles.code}>{po.po_code}</Text>
          <StatusPill label={PO_STATUS_LABEL[po.status] ?? po.status} color={poStatusColor(po.status)} />
        </View>
        <Text style={styles.supplier}>{po.suppliers?.name ?? 'No supplier assigned'}</Text>
        <Text style={styles.meta}>
          {po.auto_created
            ? `Raised automatically on a stock shortfall${
                po.orders?.order_code ? ` for ${po.orders.order_code}` : ''
              }`
            : 'Raised by the store manager'}
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* ---- The three statuses, on one line ---- */}
        <View style={styles.flow}>
          {PO_FLOW.map((f, i) => (
            <React.Fragment key={f.key}>
              {i > 0 ? (
                <Ionicons
                  name="arrow-forward"
                  size={14}
                  color={i <= step ? colors.primary : colors.border}
                />
              ) : null}
              <View style={[styles.flowStep, i <= step && styles.flowStepOn]}>
                <Text style={[styles.flowText, i <= step && styles.flowTextOn]}>{f.label}</Text>
              </View>
            </React.Fragment>
          ))}
        </View>
        <Text style={styles.flowMeta}>
          {po.procured_at ? `Procured ${new Date(po.procured_at).toLocaleDateString()}` : null}
          {po.procured_at && po.paid_at ? ' · ' : null}
          {po.paid_at ? `Paid ${new Date(po.paid_at).toLocaleDateString()}` : null}
          {po.status === 'received' ? ' · Received into stock' : null}
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* ---- The one transition this screen offers ---- */}
        {canProcure ? (
          <AppButton
            title="Procured"
            icon="checkmark-circle-outline"
            onPress={() => {
              setError(null);
              setConfirmProcured(true);
            }}
            loading={procured.isPending}
            style={styles.action}
          />
        ) : null}

        {po.status === 'procured' ? (
          <ActionBanner
            title="With the accountant"
            subtitle="Bought from the supplier. The accountant pays it from their Payables ledger — there is no approval step in between."
            style={styles.bannerGap}
          />
        ) : null}

        {po.status === 'paid' ? (
          <ActionBanner
            tone="neutral"
            title="Paid"
            subtitle="A goods-receipt note is in the store manager's queue. Stock rises only once they confirm what physically arrived."
            style={styles.bannerGap}
          />
        ) : null}

        {po.status === 'received' ? (
          <ActionBanner
            tone="neutral"
            title="Received into stock"
            subtitle="The store manager confirmed receipt and inventory has been updated."
            style={styles.bannerGap}
          />
        ) : null}

        {/* ---- Save / download ---- */}
        <AppButton
          title="Save or share as PDF"
          variant="secondary"
          icon="download-outline"
          loading={exporting}
          disabled={exporting}
          onPress={async () => {
            setError(null);
            setExporting(true);
            try {
              await sharePoPdf(po);
            } catch (e) {
              setError(describeDbError(e, 'Export'));
            } finally {
              setExporting(false);
            }
          }}
          style={styles.action}
        />

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
                  {Number(it.quantity_meters).toLocaleString()}
                </Text>
              </View>
            ))}
          </View>
          {po.amount ? (
            <Text style={styles.amount}>
              Amount: <Text style={styles.mono}>{Number(po.amount).toLocaleString()}</Text>
            </Text>
          ) : null}
          {po.notes ? <Text style={styles.note}>{po.notes}</Text> : null}
        </Section>

        {/* A bill uploaded before 0089 — procurement can no longer attach one,
            but a historical PO that carries one should still show it. */}
        {billUrl ? (
          <Section title="Supplier bill">
            <Image source={{ uri: billUrl }} style={styles.bill} resizeMode="contain" />
          </Section>
        ) : null}
      </ScrollView>

      <ConfirmDialog
        visible={confirmProcured}
        title="Mark this purchase order procured?"
        message={`${po.po_code} goes to the accountant to be paid. Only do this once you have actually placed the order with ${
          po.suppliers?.name ?? 'the supplier'
        }.`}
        confirmLabel="Procured"
        loading={procured.isPending}
        onConfirm={() => procured.mutate()}
        onCancel={() => {
          setConfirmProcured(false);
          setError(null);
        }}
      />
    </Screen>
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
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.title,
    color: colors.ink,
    fontWeight: fontWeight.semibold,
  },
  supplier: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.ink },
  meta: { marginTop: 2, fontSize: fontSize.caption, color: colors.inkMuted },
  stitch: { marginVertical: spacing.lg },

  flow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  flowStep: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  flowStepOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  flowText: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.caption,
    color: colors.inkMuted,
    fontWeight: fontWeight.medium,
  },
  flowTextOn: { color: colors.white, fontWeight: fontWeight.semibold },
  flowMeta: { marginTop: spacing.sm, fontSize: fontSize.caption, color: colors.inkMuted },

  action: { marginTop: spacing.lg },
  bannerGap: { marginTop: spacing.lg },
  section: { marginTop: spacing.xl },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
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
  tableHeadRow: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  th: {
    padding: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
  },
  td: { padding: spacing.sm, fontSize: fontSize.secondary, color: colors.ink },
  colItem: { flex: 2 },
  colQty: { flex: 1, textAlign: 'right' },
  mono: { fontFamily: fontFamily.mono },
  amount: { marginTop: spacing.sm, fontSize: fontSize.secondary, color: colors.ink },
  note: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.inkMuted },
  bill: { width: '100%', height: 260, borderRadius: radius.md, backgroundColor: colors.bg },
  error: { marginTop: spacing.md, fontSize: fontSize.secondary, color: colors.alert },
});
