/**
 * Add a bill or a maintenance expense.
 *
 * TWO RULES LIVE HERE.
 *
 * 1. The photo is required. The button stays disabled until one is attached, and
 *    the RPC refuses regardless — the UI is the courtesy, the DB is the rule.
 *
 * 2. The bill type is free text. Typing a name that has never been used before
 *    IS how a new bill type gets added; there is no enum and no admin screen.
 *    Previously-used names are offered as chips so the second electricity bill
 *    reuses the first one's spelling instead of quietly creating a near-duplicate
 *    type that splits the totals.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { SelectField } from '../../components/forms/SelectField';
import { StitchLine } from '../../components/ui/StitchLine';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { addExpense } from '../../api/endpoints/finance';
import { listBillSubtypes } from '../../api/endpoints/accounting';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';

export function AccountantAddExpenseScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const category: 'bills' | 'maintenance' = route.params?.category ?? 'bills';
  const isBills = category === 'bills';

  const [subtype, setSubtype] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [proof, setProof] = useState<LocalPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: knownTypes } = useQuery({
    queryKey: ['acctBillSubtypes'],
    queryFn: listBillSubtypes,
    enabled: isBills,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!profile?.factory_id) throw new Error('No factory on your profile.');
      const path = await uploadOrderPhoto(
        profile.factory_id,
        category === 'bills' ? 'bills' : 'maintenance',
        proof[0].uri,
        'proof'
      );
      return addExpense({
        category,
        amount: Number(amount),
        description: description.trim() || null,
        proofUrl: path,
        recurring,
        billSubtype: isBills ? subtype.trim() : null,
      });
    },
    onSuccess: () => {
      for (const k of ['acctPayableExpenses', 'acctBillSubtypes', 'expenses', 'approvals', 'reportPl']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
      navigation.goBack();
    },
    onError: (e) => setError(describeDbError(e, isBills ? 'Bill' : 'Expense')),
  });

  const hasPhoto = proof.length > 0;

  function onSave() {
    setError(null);
    if (isBills && !subtype.trim()) {
      setError('Name the bill type (e.g. electricity).');
      return;
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!hasPhoto) {
      setError('Attach a photo of the bill or receipt — it is required.');
      return;
    }
    save.mutate();
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={local.content} keyboardShouldPersistTaps="handled">
        <Text style={local.title}>{isBills ? 'Add a bill' : 'Add a maintenance expense'}</Text>
        <Text style={local.intro}>
          {isBills
            ? 'The bill type is whatever you name it. A name you have not used before becomes a new type.'
            : 'Recorded against maintenance and sent to the owner for approval.'}
        </Text>

        <View style={local.stitch}>
          <StitchLine />
        </View>

        {isBills ? (
          <>
            <TextField
              label="Bill type"
              value={subtype}
              onChangeText={setSubtype}
              placeholder="e.g. electricity"
              required
            />
            {(knownTypes ?? []).length > 0 ? (
              <View style={local.suggestions}>
                <Text style={local.suggestLabel}>Used before</Text>
                <View style={local.chips}>
                  {(knownTypes ?? []).map((t) => {
                    const on = subtype.trim().toLowerCase() === t.bill_subtype.toLowerCase();
                    return (
                      <Pressable
                        key={t.bill_subtype}
                        onPress={() => setSubtype(t.bill_subtype)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        style={({ pressed }) => [
                          local.chip,
                          on && local.chipOn,
                          pressed && { opacity: 0.75 },
                        ]}
                      >
                        <Text style={[local.chipText, on && local.chipTextOn]}>{t.bill_subtype}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </>
        ) : null}

        <TextField label="Amount" value={amount} onChangeText={setAmount} required numeric mono />
        <TextField
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder={isBills ? 'e.g. July meter reading' : 'e.g. M-12 hook replacement'}
          multiline
        />
        <SelectField
          label="Recurring monthly?"
          value={recurring ? 'yes' : 'no'}
          options={[
            { value: 'no', label: 'One-off' },
            { value: 'yes', label: 'Recurring' },
          ]}
          onChange={(v) => setRecurring(v === 'yes')}
        />

        <PhotoPicker
          label="Photo of the bill (required)"
          hint="No money is recorded in this app without a photo of the paperwork."
          photos={proof}
          onChange={setProof}
          multiple={false}
        />
        {!hasPhoto ? (
          <Text style={local.gate}>Attach a photo to enable saving.</Text>
        ) : null}

        {error ? <Text style={local.error}>{error}</Text> : null}

        <View style={local.actions}>
          <AppButton
            title="Cancel"
            variant="secondary"
            onPress={() => navigation.goBack()}
            style={{ flex: 1 }}
          />
          <AppButton
            title={isBills ? 'Save bill' : 'Save expense'}
            onPress={onSave}
            loading={save.isPending}
            disabled={!hasPhoto}
            style={{ flex: 1 }}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const local = StyleSheet.create({
  content: { padding: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  intro: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  stitch: { marginVertical: spacing.lg },
  suggestions: { marginTop: -spacing.sm, marginBottom: spacing.lg },
  suggestLabel: { fontSize: fontSize.caption, color: colors.slate, marginBottom: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.caption, color: colors.slate, fontWeight: fontWeight.medium },
  chipTextOn: { color: colors.indigoDeep },
  gate: { marginTop: -spacing.sm, marginBottom: spacing.md, fontSize: fontSize.caption, color: colors.warning },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.md },
});

export default AccountantAddExpenseScreen;
