/**
 * Login — email + password against Supabase Auth (chosen over magic links for
 * factory-floor use). On success, AuthContext fetches role + factory_id and the
 * role router mounts the right navigator.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { Controller, useForm } from 'react-hook-form';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { StitchLine } from '../../components/ui/StitchLine';
import { useAuth, FACTORY_INACTIVE_MESSAGE } from '../../auth/AuthContext';
import { isSupabaseConfigured } from '../../api/client';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  radius,
} from '../../constants/theme';

interface FormValues {
  email: string;
  password: string;
}

export function LoginScreen() {
  const { signIn } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { control, handleSubmit } = useForm<FormValues>({
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: FormValues) {
    setError(null);
    setSubmitting(true);
    try {
      await signIn(values.email, values.password);
    } catch (e: any) {
      setError(mapAuthError(e?.message));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.wordmark}>FACTORY ERP</Text>
            <Text style={styles.tagline}>Embroidery production, tracked end to end.</Text>
            <View style={styles.stitch}>
              <StitchLine />
            </View>
          </View>

          {!isSupabaseConfigured && (
            <View style={styles.configWarn}>
              <Text style={styles.configWarnText}>
                Supabase isn't configured yet. Add your project URL and anon key to{' '}
                <Text style={styles.mono}>.env</Text>, then restart with{' '}
                <Text style={styles.mono}>npx expo start -c</Text>.
              </Text>
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <Controller
              control={control}
              name="email"
              rules={{ required: 'Email is required' }}
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={styles.input}
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  placeholder="you@factory.test"
                  placeholderTextColor={colors.slate}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                />
              )}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <Controller
              control={control}
              name="password"
              rules={{ required: 'Password is required' }}
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  style={styles.input}
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                  placeholder="••••••••"
                  placeholderTextColor={colors.slate}
                  secureTextEntry
                  textContentType="password"
                />
              )}
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <AppButton
            title="Sign in"
            onPress={handleSubmit(onSubmit)}
            loading={submitting}
            style={{ marginTop: spacing.md }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function mapAuthError(message?: string): string {
  if (!message) return 'Something went wrong. Please try again.';
  if (message === FACTORY_INACTIVE_MESSAGE) return FACTORY_INACTIVE_MESSAGE;
  if (/invalid login credentials/i.test(message)) return 'Incorrect email or password.';
  if (/email not confirmed/i.test(message)) return 'This account is not confirmed yet.';
  if (/network/i.test(message)) return 'Network error — check your connection.';
  return message;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  brand: { marginBottom: spacing.xl },
  wordmark: {
    fontSize: 34,
    fontWeight: fontWeight.semibold,
    color: colors.indigo,
    letterSpacing: 2,
  },
  tagline: {
    marginTop: spacing.xs,
    fontSize: fontSize.secondary,
    color: colors.slate,
  },
  stitch: { marginTop: spacing.lg },
  field: { marginBottom: spacing.lg },
  label: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.indigoDeep,
    marginBottom: spacing.xs,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.body,
    color: colors.indigoDeep,
    backgroundColor: colors.surface,
  },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  configWarn: {
    backgroundColor: colors.tintCoral,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  configWarnText: { color: colors.indigoDeep, fontSize: fontSize.secondary, lineHeight: 20 },
  mono: { fontFamily: 'monospace', color: colors.indigo },
});
