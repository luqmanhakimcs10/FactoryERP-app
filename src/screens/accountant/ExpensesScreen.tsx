/**
 * Fixed & manual expenses, plus partner payments.
 *
 * PARTNER PAYMENTS ARE THE SPECIAL CASE. Recording one writes THREE rows in a
 * single RPC — payments, expenses (category=partner_payment), partner_ledger —
 * because three different readers depend on them agreeing:
 *   the P&L sums `expenses` with no special-casing for partners,
 *   the payables view reads `payments`,
 *   the partner's own dashboard reads `partner_ledger`.
 * Writing only one leaves the other two silently wrong, so this is never split
 * into separate client calls.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { SelectField } from '../../components/forms/SelectField';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { StatusPill } from '../../components/ui/StatusPill';
import { addExpense, listExpenses, payPartner } from '../../api/endpoints/finance';
import { listMasters } from '../../api/endpoints/masters';
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

const CATEGORIES = [
  { value: 'rent', label: 'Rent' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'bills', label: 'Bills' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'materials', label: 'Materials' },
  { value: 'other', label: 'Other' },
];

type Mode = 'list' | 'expense' | 'partner';

export function ExpensesScreen() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const [mode, setMode] = useState<Mode>('list');
  const [category, setCategory] = useState<string | null>('rent');
  const [billSubtype, setBillSubtype] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [proof, setProof] = useState<LocalPhoto[]>([]);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threeWay, setThreeWay] = useState<{ payment_id: string; expense_id: string; partner_ledger_id: string } | null>(null);

  const { data: expenses, isLoading } = useQuery({
    queryKey: ['expenses'],
    queryFn: () => listExpenses(),
  });
  const { data: partners } = useQuery({
    queryKey: ['masters', 'finishing_partners', '', false],
    queryFn: () => listMasters({ table: 'finishing_partners', searchField: 'name' }),
  });

  function reset() {
    setAmount(''); setDescription(''); setProof([]); setRecurring(false);
    setPartnerId(null); setError(null); setBillSubtype('');
  }
  function invalidate() {
    for (const k of [
      'expenses', 'payments', 'partnerLedger', 'approvals', 'reportPl',
      'acctPayableExpenses', 'acctBillSubtypes', 'acctPayablePartners',
    ]) {
      queryClient.invalidateQueries({ queryKey: [k] });
    }
  }

  // The photo is not optional any more: no upload, no posting. Both mutations
  // therefore treat a missing photo as a programming error — the forms below
  // never let it get this far, and the RPC refuses regardless.
  const expenseMutation = useMutation({
    mutationFn: async () => {
      if (!proof[0] || !profile?.factory_id) throw new Error('Attach a photo of the bill first.');
      const path = await uploadOrderPhoto(profile.factory_id, 'expenses', proof[0].uri, 'proof');
      return addExpense({
        category: category as string,
        amount: Number(amount),
        description: description.trim() || null,
        proofUrl: path,
        recurring,
        billSubtype: category === 'bills' ? billSubtype.trim() : null,
      });
    },
    onSuccess: () => { invalidate(); reset(); setMode('list'); },
    onError: (e) => setError(describeDbError(e, 'Expense')),
  });

  const partnerMutation = useMutation({
    mutationFn: async () => {
      if (!proof[0] || !profile?.factory_id) throw new Error('Attach the payment proof first.');
      const path = await uploadOrderPhoto(profile.factory_id, 'partner-pay', proof[0].uri, 'proof');
      return payPartner({
        partnerId: partnerId as string,
        amount: Number(amount),
        proofUrl: path,
        note: description.trim() || null,
      });
    },
    onSuccess: (r) => { setThreeWay(r); invalidate(); },
    onError: (e) => setError(describeDbError(e, 'Partner payment')),
  });

  // ---- Add expense form ----
  if (mode === 'expense') {
    return (
      <Screen>
        <FlatList
          data={[]}
          renderItem={null as any}
          ListHeaderComponent={
            <View>
              <Text style={styles.title}>Add expense</Text>
              <SelectField
                label="Category"
                value={category}
                options={CATEGORIES}
                onChange={setCategory}
                required
              />
              {category === 'bills' ? (
                <TextField
                  label="Bill type"
                  value={billSubtype}
                  onChangeText={setBillSubtype}
                  placeholder="e.g. electricity"
                  required
                />
              ) : null}
              <TextField label="Amount" value={amount} onChangeText={setAmount} required numeric mono />
              <TextField
                label="Description"
                value={description}
                onChangeText={setDescription}
                placeholder="e.g. July factory rent"
                multiline
              />
              <SelectField
                label="Recurring monthly?"
                value={recurring ? 'yes' : 'no'}
                options={[{ value: 'no', label: 'One-off' }, { value: 'yes', label: 'Recurring' }]}
                onChange={(v) => setRecurring(v === 'yes')}
              />
              <PhotoPicker
                label="Proof (required)"
                hint="Attach the bill or receipt. No expense is recorded without one."
                photos={proof}
                onChange={setProof}
                multiple={false}
              />
              {proof.length === 0 ? (
                <Text style={styles.gate}>Attach a photo to enable saving.</Text>
              ) : null}
              <Text style={styles.note}>
                Expenses are recorded as pending and appear in the owner's
                Approvals Inbox.
              </Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <View style={styles.actions}>
                <AppButton title="Cancel" variant="secondary" onPress={() => { reset(); setMode('list'); }} style={{ flex: 1 }} />
                <AppButton
                  title="Save expense"
                  onPress={() => {
                    setError(null);
                    const n = Number(amount);
                    if (!Number.isFinite(n) || n <= 0) return setError('Enter an amount greater than zero.');
                    if (category === 'bills' && !billSubtype.trim()) {
                      return setError('Name the bill type (e.g. electricity).');
                    }
                    if (proof.length === 0) {
                      return setError('Attach a photo of the bill or receipt — it is required.');
                    }
                    expenseMutation.mutate();
                  }}
                  loading={expenseMutation.isPending}
                  disabled={proof.length === 0}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          }
        />
      </Screen>
    );
  }

  // ---- Partner payment form ----
  if (mode === 'partner') {
    return (
      <Screen>
        <FlatList
          data={[]}
          renderItem={null as any}
          ListHeaderComponent={
            <View>
              <Text style={styles.title}>Pay a finishing partner</Text>

              {threeWay ? (
                <>
                  <ActionBanner
                    tone="neutral"
                    title="Payment posted to all three ledgers"
                    subtitle={
                      '· payment recorded (payable)\n' +
                      '· expense created (partner_payment) — so the P&L needs no special case\n' +
                      '· partner ledger entry created — so their dashboard is accurate'
                    }
                    style={styles.bannerGap}
                  />
                  <AppButton
                    title="Done"
                    variant="secondary"
                    onPress={() => { setThreeWay(null); reset(); setMode('list'); }}
                  />
                </>
              ) : (
                <>
                  <SelectField
                    label="Partner"
                    value={partnerId}
                    options={(partners ?? []).map((p: any) => ({ value: p.id, label: p.name }))}
                    onChange={setPartnerId}
                    required
                    emptyHint="No finishing partners on file."
                  />
                  <TextField label="Amount" value={amount} onChangeText={setAmount} required numeric mono />
                  <TextField
                    label="Note"
                    value={description}
                    onChangeText={setDescription}
                    placeholder="e.g. July clipping settlement"
                    multiline
                  />
                  <PhotoPicker
                    label="Payment proof (required)"
                    hint="Attach the transfer screenshot or receipt."
                    photos={proof}
                    onChange={setProof}
                    multiple={false}
                  />
                  {proof.length === 0 ? (
                    <Text style={styles.gate}>Attach a photo to enable saving.</Text>
                  ) : null}
                  <Text style={styles.note}>
                    This single action writes the payment, the expense and the
                    partner's ledger entry together.
                  </Text>
                  {error ? <Text style={styles.error}>{error}</Text> : null}
                  <View style={styles.actions}>
                    <AppButton title="Cancel" variant="secondary" onPress={() => { reset(); setMode('list'); }} style={{ flex: 1 }} />
                    <AppButton
                      title="Record payment"
                      onPress={() => {
                        setError(null);
                        if (!partnerId) return setError('Choose a partner.');
                        const n = Number(amount);
                        if (!Number.isFinite(n) || n <= 0) return setError('Enter an amount greater than zero.');
                        if (proof.length === 0) {
                          return setError('Attach the payment proof — it is required.');
                        }
                        partnerMutation.mutate();
                      }}
                      loading={partnerMutation.isPending}
                      disabled={proof.length === 0}
                      style={{ flex: 1 }}
                    />
                  </View>
                </>
              )}
            </View>
          }
        />
      </Screen>
    );
  }

  // ---- List ----
  return (
    <Screen padded={false}>
      <FlatList
        data={expenses ?? []}
        keyExtractor={(e) => e.id}
        ListHeaderComponent={
          <View style={styles.header}>
            <Pressable
              onPress={() => setMode('expense')}
              accessibilityRole="button"
              style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.75 }]}
            >
              <Text style={styles.addBtnText}>+ Add expense</Text>
            </Pressable>
            <Pressable
              onPress={() => setMode('partner')}
              accessibilityRole="button"
              style={({ pressed }) => [styles.addBtnAlt, pressed && { opacity: 0.75 }]}
            >
              <Text style={styles.addBtnAltText}>Pay a finishing partner</Text>
            </Pressable>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
          </View>
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No expenses recorded</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowTop}>
              <Text style={styles.cat}>
                {item.category.replace(/_/g, ' ')}
                {item.bill_subtype ? ` · ${item.bill_subtype}` : ''}
              </Text>
              <StatusPill
                label={item.status === 'approved' ? 'Approved' : item.status === 'rejected' ? 'Rejected' : 'Pending'}
                color={
                  item.status === 'approved' ? colors.success
                  : item.status === 'rejected' ? colors.alert
                  : colors.warning
                }
              />
            </View>
            <Text style={styles.amount}>{Number(item.amount).toLocaleString()}</Text>
            {item.description ? <Text style={styles.meta}>{item.description}</Text> : null}
            <Text style={styles.meta}>
              {new Date(item.expense_date).toLocaleDateString()}
              {item.recurring ? ' · recurring' : ''}
            </Text>
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  header: { padding: spacing.lg, gap: spacing.md },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep, marginBottom: spacing.lg },
  addBtn: { minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: radius.md, backgroundColor: colors.brass },
  addBtnText: { color: colors.indigoDeep, fontSize: fontSize.body, fontWeight: fontWeight.semibold },
  addBtnAlt: { minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.indigo },
  addBtnAltText: { color: colors.indigo, fontSize: fontSize.secondary, fontWeight: fontWeight.medium },
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
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  cat: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep, textTransform: 'capitalize' },
  amount: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.indigoDeep },
  meta: { fontSize: fontSize.caption, color: colors.slate },
  note: { fontSize: fontSize.caption, color: colors.slate, fontStyle: 'italic', marginBottom: spacing.md, lineHeight: 18 },
  gate: { marginTop: -spacing.sm, marginBottom: spacing.md, fontSize: fontSize.caption, color: colors.warning },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.md },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
  center: { padding: spacing.xl, alignItems: 'center' },
  emptyTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
});
