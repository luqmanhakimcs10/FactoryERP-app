/**
 * Invoice detail + payment recording + loan entry.
 *
 * The payment form is shared by both directions: a receivable against an invoice
 * (which also marks the invoice paid) and a payable against a PO (which resolves
 * Phase 4's "awaiting accountant payment"). Both always capture proof.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { SelectField } from '../../components/forms/SelectField';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import { listInvoices, recordPayment, listPayments, addLoan } from '../../api/endpoints/finance';
import { listFactoryWorkers } from '../../api/endpoints/shifts';
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
} from '../../constants/theme';

// ---------------------------------------------------------------------------
// Invoice detail -> record receivable
// ---------------------------------------------------------------------------
export function InvoiceDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const invoiceId: string = route.params?.invoiceId;

  const [amount, setAmount] = useState('');
  const [proof, setProof] = useState<LocalPhoto[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const { data: invoices, isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => listInvoices(),
  });
  const { data: payments } = useQuery({
    queryKey: ['payments', 'receivable'],
    queryFn: () => listPayments('receivable'),
  });

  const inv = invoices?.find((i) => i.id === invoiceId);

  React.useEffect(() => {
    if (inv && !amount) setAmount(String(inv.amount));
  }, [inv]);

  const payMutation = useMutation({
    mutationFn: async () => {
      // Proof is mandatory — the RPC refuses without it, and so does the button.
      if (!proof[0] || !profile?.factory_id) throw new Error('Attach the payment proof first.');
      const proofPath = await uploadOrderPhoto(
        profile.factory_id, `inv-${invoiceId}`, proof[0].uri, 'proof'
      );
      return recordPayment({
        refType: 'invoice',
        refId: invoiceId,
        amount: Number(amount),
        proofUrl: proofPath,
        note: note.trim() || null,
      });
    },
    onSuccess: () => {
      setDone(true);
      // The accountant's Clients and Receivable views read the same money
      // through different RPCs; they go stale unless invalidated together.
      for (const k of [
        'invoices', 'payments', 'reportPl',
        'acctClients', 'acctClientInvoices', 'acctReceivableSummary', 'acctReceivableInvoices',
      ]) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
    },
    onError: (e) => setError(describeDbError(e, 'Payment')),
  });

  if (isLoading || !inv) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const history = (payments ?? []).filter((p) => p.ref_id === invoiceId);
  const isPaid = inv.status === 'paid';

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <Text style={styles.code}>{inv.invoice_code}</Text>
          <StatusPill
            label={isPaid ? 'Paid' : 'Pending'}
            color={isPaid ? colors.success : colors.warning}
          />
        </View>
        <Text style={styles.sub}>
          {inv.orders?.vendors?.name ?? '—'}
          {inv.orders?.order_code ? ` · ${inv.orders.order_code}` : ''}
        </Text>
        <Text style={styles.hero}>{Number(inv.amount).toLocaleString()}</Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {done ? (
          <ActionBanner
            tone="neutral"
            title="Payment recorded"
            subtitle="The invoice is now marked paid."
            style={styles.bannerGap}
          />
        ) : null}

        {history.length ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Payment history</Text>
            {history.map((p) => (
              <View key={p.id} style={styles.histRow}>
                <Text style={styles.mono}>{Number(p.amount).toLocaleString()}</Text>
                <Text style={styles.meta}>{new Date(p.paid_at).toLocaleDateString()}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {!isPaid && !done ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Record payment</Text>
            <TextField
              label="Amount received"
              value={amount}
              onChangeText={setAmount}
              required
              numeric
              mono
            />
            <PhotoPicker
              label="Payment proof (required)"
              hint="Attach the transfer screenshot or receipt. No payment is recorded without one."
              photos={proof}
              onChange={setProof}
              multiple={false}
            />
            {proof.length === 0 ? (
              <Text style={styles.gate}>Attach a photo to enable recording.</Text>
            ) : null}
            <TextField
              label="Note"
              value={note}
              onChangeText={setNote}
              placeholder="e.g. Bank transfer ref 88213"
              multiline
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <AppButton
              title="Record payment"
              onPress={() => {
                setError(null);
                const n = Number(amount);
                if (!Number.isFinite(n) || n <= 0) {
                  setError('Enter an amount greater than zero.');
                  return;
                }
                if (proof.length === 0) {
                  setError('Attach the payment proof — it is required.');
                  return;
                }
                payMutation.mutate();
              }}
              loading={payMutation.isPending}
              disabled={proof.length === 0}
            />
          </View>
        ) : (
          <AppButton
            title="Back to ledgers"
            variant="secondary"
            onPress={() => navigation.navigate('RoleHome')}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Record a payable against a PO
// ---------------------------------------------------------------------------
export function RecordPoPaymentScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const poId: string = route.params?.poId;
  const poCode: string | undefined = route.params?.poCode;
  const suggested: number | undefined = route.params?.amount;

  const [amount, setAmount] = useState(suggested ? String(suggested) : '');
  const [proof, setProof] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const payMutation = useMutation({
    mutationFn: async () => {
      if (!proof[0] || !profile?.factory_id) throw new Error('Attach the payment proof first.');
      const proofPath = await uploadOrderPhoto(
        profile.factory_id, `po-${poId}`, proof[0].uri, 'proof'
      );
      return recordPayment({
        refType: 'po',
        refId: poId,
        amount: Number(amount),
        proofUrl: proofPath,
      });
    },
    onSuccess: () => {
      setDone(true);
      for (const k of [
        'purchaseOrders', 'purchaseOrder', 'payments',
        'acctSuppliers', 'acctSupplierPos', 'acctPayableSuppliers',
      ]) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
    },
    onError: (e) => setError(describeDbError(e, 'Payment')),
  });

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.code}>{poCode ?? 'Purchase order'}</Text>
        <Text style={styles.sub}>Record supplier payment</Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {done ? (
          <>
            <ActionBanner
              tone="neutral"
              title="Payment recorded"
              subtitle="The PO now moves to procurement for handover to the store."
              style={styles.bannerGap}
            />
            <AppButton title="Back" variant="secondary" onPress={() => navigation.goBack()} />
          </>
        ) : (
          <>
            <TextField
              label="Amount paid"
              value={amount}
              onChangeText={setAmount}
              required
              numeric
              mono
            />
            <PhotoPicker
              label="Payment proof (required)"
              hint="Attach the transfer screenshot. No payment is recorded without one."
              photos={proof}
              onChange={setProof}
              multiple={false}
            />
            {proof.length === 0 ? (
              <Text style={styles.gate}>Attach a photo to enable recording.</Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <AppButton
              title="Record payment"
              onPress={() => {
                setError(null);
                const n = Number(amount);
                if (!Number.isFinite(n) || n <= 0) {
                  setError('Enter an amount greater than zero.');
                  return;
                }
                if (proof.length === 0) {
                  setError('Attach the payment proof — it is required.');
                  return;
                }
                payMutation.mutate();
              }}
              loading={payMutation.isPending}
              disabled={proof.length === 0}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Add loan
// ---------------------------------------------------------------------------
export function AddLoanScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();

  const [workerId, setWorkerId] = useState<string | null>(null);
  const [principal, setPrincipal] = useState('');
  const [installment, setInstallment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ starts_period: string | null } | null>(null);

  const { data: workers } = useQuery({
    queryKey: ['factoryWorkers'],
    queryFn: listFactoryWorkers,
  });

  const addMutation = useMutation({
    mutationFn: () =>
      addLoan({
        workerId: workerId as string,
        principal: Number(principal),
        installment: Number(installment),
      }),
    onSuccess: (l) => {
      setResult({ starts_period: l.starts_period });
      queryClient.invalidateQueries({ queryKey: ['loans'] });
    },
    onError: (e) => setError(describeDbError(e, 'Loan')),
  });

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Record a loan</Text>
        <Text style={styles.intro}>
          Loans are approved outside the app. This only records an already-approved
          loan so installments can be deducted automatically.
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {result ? (
          <>
            <ActionBanner
              tone="neutral"
              title="Loan recorded"
              subtitle={`Deductions begin in ${result.starts_period}. Periods already run are never touched.`}
              style={styles.bannerGap}
            />
            <AppButton title="Back to ledgers" variant="secondary" onPress={() => navigation.goBack()} />
          </>
        ) : (
          <>
            <SelectField
              label="Worker"
              value={workerId}
              options={(workers ?? []).map((w: any) => ({
                value: w.worker_id ?? w.id,
                label: w.display_name ?? w.worker_name,
              }))}
              onChange={setWorkerId}
              required
              emptyHint="No workers on file."
            />
            <TextField
              label="Principal"
              value={principal}
              onChangeText={setPrincipal}
              placeholder="5000"
              required
              numeric
              mono
            />
            <TextField
              label="Installment per period"
              value={installment}
              onChangeText={setInstallment}
              placeholder="1000"
              required
              numeric
              mono
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <AppButton
              title="Record loan"
              onPress={() => {
                setError(null);
                if (!workerId) return setError('Choose a worker.');
                const p = Number(principal), i = Number(installment);
                if (!Number.isFinite(p) || p <= 0) return setError('Enter a principal greater than zero.');
                if (!Number.isFinite(i) || i <= 0) return setError('Enter an installment greater than zero.');
                if (i > p) return setError('Installment cannot exceed the principal.');
                addMutation.mutate();
              }}
              loading={addMutation.isPending}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  intro: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  sub: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.indigoDeep },
  hero: { marginTop: spacing.sm, fontSize: fontSize.hero, fontFamily: fontFamily.mono, color: colors.indigoDeep },
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
  histRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  gate: { marginTop: -spacing.sm, marginBottom: spacing.md, fontSize: fontSize.caption, color: colors.warning },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
});
