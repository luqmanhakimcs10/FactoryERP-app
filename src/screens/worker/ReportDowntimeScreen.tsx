/**
 * Report Downtime — a worker logs unplanned machine stops mid-shift.
 *
 * Proactive, not part of shift close: the floor manager already records downtime
 * at close, but a stopped machine shouldn't wait for the end of a shift to be
 * visible. The submit RPC verifies the shift is the caller's and open.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { TextField } from '../../components/forms/TextField';
import { AppButton } from '../../components/ui/AppButton';
import { reportDowntime } from '../../api/endpoints/dashboards';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';

type RouteParams = { shiftId: string };

export function ReportDowntimeScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<{ ReportDowntime: RouteParams }, 'ReportDowntime'>>();
  const { shiftId } = route.params;

  const [duration, setDuration] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const minutes = Number(duration);
  const canSubmit =
    !submitting && !done && Number.isFinite(minutes) && minutes > 0 && reason.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await reportDowntime({ shiftId, durationMinutes: minutes, reason: reason.trim() });
      setDone(true);
    } catch (e) {
      setError(describeDbError(e, 'Downtime report'));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <View style={styles.done}>
          <Text style={styles.doneTitle}>Downtime reported</Text>
          <Text style={styles.doneBody}>
            {minutes} minutes logged for this shift. The floor manager can see it alongside their
            own shift-close record.
          </Text>
          <AppButton title="Back to dashboard" variant="brass" onPress={() => navigation.goBack()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Shift downtime</Text>
            <Text style={styles.cardBody}>
              Log how long the machine was stopped and why. This helps the floor manager spot
              recurring problems before they hit output.
            </Text>
          </View>

          <TextField
            label="Stopped for (minutes)"
            value={duration}
            onChangeText={setDuration}
            placeholder="e.g. 20"
            numeric
            required
            mono
          />
          <TextField
            label="Reason"
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. thread snap, needle break, power cut"
            multiline
            required
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <AppButton
            title={submitting ? 'Submitting…' : 'Submit report'}
            onPress={submit}
            loading={submitting}
            disabled={!canSubmit}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.xs,
  },
  cardTitle: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  cardBody: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  error: { marginBottom: spacing.lg, fontSize: fontSize.secondary, color: colors.alert },
  done: { flex: 1, justifyContent: 'center', gap: spacing.md },
  doneTitle: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.success },
  doneBody: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
});
