/**
 * Super Admin — "Edit" from a factory row's ⋮ menu.
 *
 * Edits the same fields NewFactoryScreen captures, minus the two that cannot
 * change after creation: the factory NAME and its CODE PREFIX. `sa_update_factory`
 * does not accept a name, and the prefix is baked into every order, PO, GRN and
 * audit code that factory has ever issued — offering either as an editable box
 * would be offering something the database will quietly refuse.
 *
 * Modules are not here either: they are their own top-level tab now.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { DateField } from '../../components/forms/DateField';
import { StitchLine } from '../../components/ui/StitchLine';
import { saFactoryList, saUpdateFactory } from '../../api/endpoints/factories';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, fontSize, fontWeight, fontFamily } from '../../constants/theme';

export function EditFactoryScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const factoryId: string = route.params?.factoryId;

  const { data: factories, isLoading } = useQuery({
    queryKey: ['saFactoryList'],
    queryFn: saFactoryList,
  });
  const factory = factories?.find((f) => f.id === factoryId);

  const [representativeName, setRepresentativeName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [subscriptionAmount, setSubscriptionAmount] = useState('');
  const [nextBillingDate, setNextBillingDate] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!factory) return;
    setRepresentativeName(factory.representative_name ?? '');
    setPhone(factory.phone ?? '');
    setAddress(factory.address ?? '');
    setSubscriptionAmount(
      factory.subscription_amount === null || factory.subscription_amount === undefined
        ? ''
        : String(factory.subscription_amount)
    );
    setNextBillingDate(factory.next_billing_date ?? null);
  }, [factory]);

  async function onSubmit() {
    setError(null);
    const amount = subscriptionAmount.trim() === '' ? null : Number(subscriptionAmount);
    if (amount !== null && (Number.isNaN(amount) || amount < 0)) {
      setError('Enter a valid subscription amount.');
      return;
    }

    setSubmitting(true);
    try {
      await saUpdateFactory(factoryId, {
        representative_name: representativeName.trim() || undefined,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
        subscription_amount: amount ?? undefined,
        next_billing_date: nextBillingDate,
      });
      await queryClient.invalidateQueries({ queryKey: ['saFactoryList'] });
      navigation.goBack();
    } catch (e: any) {
      setError(describeDbError(e, 'Factory'));
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading && !factory) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} />
      </Screen>
    );
  }

  if (!factory) {
    return (
      <Screen>
        <Text style={styles.error}>Factory not found.</Text>
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{factory.name}</Text>
        <Text style={styles.subtitle}>
          Code prefix <Text style={styles.mono}>{factory.code_prefix}</Text> · name and prefix are
          fixed once a factory has issued codes.
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

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
        <TextField label="Address" value={address} onChangeText={setAddress} multiline />
        <TextField
          label="Subscription amount"
          value={subscriptionAmount}
          onChangeText={setSubscriptionAmount}
          numeric
          mono
          placeholder="25000"
        />
        {/* No Clear here, unlike the create form. `sa_update_factory` coalesces
            every argument onto the existing value, so sending null means "leave
            it alone", not "unset it" — offering Clear would be offering an
            action the database silently ignores. */}
        <DateField
          label="Next billing date"
          value={nextBillingDate}
          onChange={setNextBillingDate}
          placeholder="Not set"
          allowClear={false}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Save changes"
          variant="brass"
          onPress={onSubmit}
          loading={submitting}
          disabled={submitting}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  subtitle: {
    marginTop: spacing.xs,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    lineHeight: 20,
  },
  mono: { fontFamily: fontFamily.mono },
  stitch: { marginVertical: spacing.lg },
  error: { marginBottom: spacing.md, fontSize: fontSize.secondary, color: colors.alert },
});
