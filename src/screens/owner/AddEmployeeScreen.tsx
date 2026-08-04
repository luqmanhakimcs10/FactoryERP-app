/**
 * Add Employee — role-first creation flow.
 *
 * Pick the role first (Worker, Manager, QA, Labour, Delivery Person, Order
 * Taker). A Worker chooses how they're paid (per stitch / per day / per month);
 * every other role is paid monthly. Submitting calls the create_employee RPC,
 * which makes the auth login + profile + compensation row in one transaction.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { SelectField, type Option } from '../../components/forms/SelectField';
import { StitchLine } from '../../components/ui/StitchLine';
import { createEmployee } from '../../api/endpoints/employees';
import type { SalaryType } from '../../models/types';
import { SALARY_TYPE_LABEL } from '../../models/types';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, fontSize, fontWeight } from '../../constants/theme';

const ROLE_OPTIONS: Option[] = [
  { value: 'worker', label: 'Worker' },
  { value: 'manager', label: 'Manager' },
  { value: 'qa', label: 'Initial QA' },
  { value: 'labour', label: 'Labour' },
  { value: 'delivery', label: 'Delivery Person' },
  { value: 'order_taker', label: 'Order Taker' },
];

const MANAGER_TYPE_OPTIONS: Option[] = [
  { value: 'floor_manager', label: 'Floor Manager' },
  { value: 'store_manager', label: 'Store Manager' },
];

const SALARY_OPTIONS: Option[] = [
  { value: 'per_stitch', label: 'Per stitch' },
  { value: 'per_day', label: 'Per day' },
  { value: 'per_month', label: 'Per month' },
];

const AMOUNT_LABEL: Record<SalaryType, string> = {
  per_stitch: 'Rate per stitch',
  per_day: 'Daily rate',
  per_month: 'Monthly salary',
};

const AMOUNT_HINT: Record<SalaryType, string> = {
  per_stitch: 'e.g. 0.5000',
  per_day: 'e.g. 1200',
  per_month: 'e.g. 45000',
};

export function AddEmployeeScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();

  const [role, setRole] = useState<string | null>(null);
  const [managerType, setManagerType] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [salaryType, setSalaryType] = useState<SalaryType | null>(null);
  const [salaryAmount, setSalaryAmount] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // "Manager" is a picker step, not a real role: the account is actually
  // created as floor_manager or store_manager so it lands on that role's
  // real dashboard instead of the placeholder generic-manager shell.
  const effectiveRole = role === 'manager' ? managerType : role;

  const create = useMutation({
    mutationFn: () =>
      createEmployee({
        email,
        password,
        displayName,
        role: effectiveRole as string,
        salaryType: (salaryType ?? 'per_month') as SalaryType,
        salaryAmount: Number(salaryAmount),
      }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['factoryProfiles'] });
      navigation.goBack();
    },
    onError: (e) => setFormError(describeDbError(e, 'Employee')),
  });

  // Non-workers are always paid monthly; only workers choose a pay type.
  const effectiveType: SalaryType =
    role === 'worker' && salaryType ? salaryType : 'per_month';

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!role) next.role = 'Choose a role first.';
    if (role === 'manager' && !managerType) next.managerType = 'Choose floor manager or store manager.';
    if (!displayName.trim()) next.displayName = 'Display name is required.';
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = 'Enter a valid email.';
    if (password.length < 8) next.password = 'Password must be at least 8 characters.';
    if (role === 'worker' && !salaryType) next.salaryType = 'Choose a pay type.';
    const amount = Number(salaryAmount);
    if (salaryAmount.trim() === '' || Number.isNaN(amount) || amount < 0) {
      next.salaryAmount = 'Enter a valid amount.';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function onSave() {
    setFormError(null);
    if (!validate()) return;
    create.mutate();
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Add employee</Text>
        <Text style={styles.subtitle}>
          Choose a role first — it decides how this employee is paid.
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        <SelectField
          label="Role"
          value={role}
          options={ROLE_OPTIONS}
          onChange={(v) => {
            setRole(v);
            if (v !== 'worker') setSalaryType(null);
            if (v !== 'manager') setManagerType(null);
          }}
          required
          error={errors.role}
        />

        {role === 'manager' ? (
          <SelectField
            label="Manager type"
            value={managerType}
            options={MANAGER_TYPE_OPTIONS}
            onChange={setManagerType}
            required
            error={errors.managerType}
          />
        ) : null}

        <TextField
          label="Display name"
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="e.g. Imran Sheikh"
          required
          error={errors.displayName}
        />

        <TextField
          label="Email (login)"
          value={email}
          onChangeText={setEmail}
          placeholder="e.g. imran@alpha.test"
          required
          error={errors.email}
          mono
        />

        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="At least 8 characters"
          required
          error={errors.password}
          mono
        />

        {role === 'worker' ? (
          <SelectField
            label="Pay type"
            value={salaryType}
            options={SALARY_OPTIONS}
            onChange={(v) => setSalaryType(v as SalaryType | null)}
            required
            error={errors.salaryType}
          />
        ) : (
          <Text style={styles.fixedNote}>Paid monthly ({SALARY_TYPE_LABEL.per_month.toLowerCase()}).</Text>
        )}

        <TextField
          label={AMOUNT_LABEL[effectiveType]}
          value={salaryAmount}
          onChangeText={setSalaryAmount}
          placeholder={AMOUNT_HINT[effectiveType]}
          required
          error={errors.salaryAmount}
          numeric
          mono
        />

        {formError ? <Text style={styles.formError}>{formError}</Text> : null}

        <AppButton
          title="Create employee"
          onPress={onSave}
          loading={create.isPending}
          disabled={create.isPending}
        />

        <Text style={styles.footnote}>
          The employee receives a login immediately and appears in the Salary Run
          by pay type once the relevant modules are enabled.
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  subtitle: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  stitch: { marginVertical: spacing.lg },
  fixedNote: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.lg, fontStyle: 'italic' },
  formError: { marginBottom: spacing.md, fontSize: fontSize.secondary, color: colors.alert, lineHeight: 20 },
  footnote: { marginTop: spacing.md, fontSize: fontSize.caption, color: colors.slate, lineHeight: 18, fontStyle: 'italic' },
});

export default AddEmployeeScreen;
