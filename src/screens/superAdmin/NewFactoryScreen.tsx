/**
 * Super Admin — create a factory with billing, contact, and module assignment
 * in one step (sa_create_factory).
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { saCreateFactory } from '../../api/endpoints/factories';
import { describeDbError } from '../../utils/errors';
import { MODULES, MODULE_LABEL, type ModuleKey } from '../../constants/roles';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
} from '../../constants/theme';

const ALL_MODULE_KEYS = Object.values(MODULES) as ModuleKey[];

export function NewFactoryScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [representativeName, setRepresentativeName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [subscriptionAmount, setSubscriptionAmount] = useState('');
  const [nextBillingDate, setNextBillingDate] = useState('');
  const [selectedModules, setSelectedModules] = useState<ModuleKey[]>([...ALL_MODULE_KEYS]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleModule(key: ModuleKey) {
    setSelectedModules((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  async function onSubmit() {
    setError(null);
    if (!name.trim()) {
      setError('Factory name is required.');
      return;
    }

    setSubmitting(true);
    try {
      const factory = await saCreateFactory({
        name: name.trim(),
        representative_name: representativeName.trim() || undefined,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
        subscription_amount: subscriptionAmount ? Number(subscriptionAmount) : 0,
        module_keys: selectedModules,
        next_billing_date: nextBillingDate.trim() || null,
      });
      await queryClient.invalidateQueries({ queryKey: ['saFactoryList'] });
      navigation.replace('FactoryDetail', { factoryId: factory.id });
    } catch (e: any) {
      setError(describeDbError(e, 'Factory'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.lede}>
          Creates the factory, sets billing defaults (active account, unpaid subscription), and
          enables the selected modules immediately.
        </Text>

        <TextField label="Factory name" value={name} onChangeText={setName} required />
        <TextField
          label="Representative name"
          value={representativeName}
          onChangeText={setRepresentativeName}
        />
        <TextField
          label="Phone number"
          value={phone}
          onChangeText={setPhone}
          placeholder="+92-300-0000000"
        />
        <TextField
          label="Address"
          value={address}
          onChangeText={setAddress}
          multiline
        />
        <TextField
          label="Subscription amount"
          value={subscriptionAmount}
          onChangeText={setSubscriptionAmount}
          numeric
          placeholder="25000"
        />
        <TextField
          label="Next billing date"
          value={nextBillingDate}
          onChangeText={setNextBillingDate}
          placeholder="YYYY-MM-DD"
        />

        <Text style={styles.sectionLabel}>Modules to enable</Text>
        <View style={styles.moduleList}>
          {ALL_MODULE_KEYS.map((key) => {
            const on = selectedModules.includes(key);
            return (
              <Pressable
                key={key}
                onPress={() => toggleModule(key)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={({ pressed }) => [
                  styles.moduleRow,
                  on && styles.moduleRowOn,
                  pressed && styles.moduleRowPressed,
                ]}
              >
                <View style={[styles.checkbox, on && styles.checkboxOn]}>
                  {on ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
                <Text style={styles.moduleLabel}>{MODULE_LABEL[key]}</Text>
              </Pressable>
            );
          })}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Create factory"
          variant="brass"
          onPress={onSubmit}
          loading={submitting}
          style={styles.submit}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  lede: {
    fontSize: fontSize.secondary,
    color: colors.slate,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  sectionLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  moduleList: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  moduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  moduleRowOn: { backgroundColor: colors.tintTeal },
  moduleRowPressed: { opacity: 0.85 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkboxOn: { backgroundColor: colors.brass, borderColor: colors.brass },
  checkmark: { color: colors.white, fontSize: 14, fontWeight: fontWeight.semibold },
  moduleLabel: { flex: 1, fontSize: fontSize.body, color: colors.indigoDeep },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.md },
  submit: { marginTop: spacing.sm },
});
