/**
 * Floor Manager — "Assign Machine". One decision, one control. (0084, Fix 2)
 *
 * WHAT THIS REPLACES
 * Until now this screen also opened a shift: pick the machine, pick the worker,
 * photograph them, set a start time, confirm. Two unrelated facts were fused —
 * "this order runs on machine 3", a production routing decision, and "Asha is
 * on machine 3 from 08:00", a payroll record. Fusing them meant the routing
 * decision could not be made unless someone was physically standing at the
 * machine, and Start Production stayed unreachable until a shift existed.
 *
 * They are separate now. This records the machine. Nothing else.
 *
 * THE SHIFT SYSTEM IS NOT GONE. Machine & Workforce → Shifts still opens shifts,
 * still captures the worker photo and counter baseline, and still drives
 * per-stitch payroll at Shift Close. It is simply no longer standing in front of
 * production. If a machine needs a shift for pay, open one there — the two flows
 * no longer block each other in either direction.
 *
 * "Start Production" is deliberately NOT here. It lives on the order row
 * alongside "Assign Machine", so both halves of the decision are visible at once
 * instead of one being reachable only through the other.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SelectField } from '../../components/forms/SelectField';
import { listMachines } from '../../api/endpoints/shifts';
import { assignMachine } from '../../api/endpoints/stageHandover';
import { describeDbError } from '../../utils/errors';
import { colors, spacing, radius, fontSize, fontWeight, tint } from '../../constants/theme';

export function AssignMachineModal() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const orderId: string = route.params?.orderId;

  const [machineId, setMachineId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: machines, isLoading: machinesLoading } = useQuery({
    queryKey: ['machines'],
    queryFn: listMachines,
  });

  const assign = useMutation({
    mutationFn: () => assignMachine(orderId, machineId!),
    onSuccess: () => {
      for (const k of ['orders', 'machines', 'machineContext', 'shiftCloseQueue']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
      queryClient.invalidateQueries({ queryKey: ['order', orderId] });
      // Back to the order row, where "Start Production" is already waiting next
      // to the now-assigned machine.
      navigation.goBack();
    },
    onError: (e) => setError(describeDbError(e, 'Assign machine')),
  });

  if (machinesLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Assign Machine</Text>
        <Text style={styles.body}>
          Pick the machine this order runs on. Production can start as soon as it is assigned.
        </Text>
        <View style={styles.stitch} />

        <SelectField
          label="Machine"
          value={machineId}
          onChange={setMachineId}
          required
          options={(machines ?? []).map((m) => ({
            value: m.id,
            label: m.has_open_shift ? `${m.name} — shift open` : m.name,
          }))}
          emptyHint="No machines are assigned to you yet."
        />

        <View style={styles.note}>
          <Text style={styles.noteHead}>Shifts are separate</Text>
          <Text style={styles.noteBody}>
            Assigning a machine does not open a shift, and production no longer waits for one.
            Open shifts under Machine &amp; Workforce → Shifts when you need them for pay — the
            per-stitch payroll at Shift Close is unchanged.
          </Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Assign Machine"
          variant="brass"
          disabled={!machineId}
          loading={assign.isPending}
          onPress={() => {
            setError(null);
            assign.mutate();
          }}
          style={{ marginTop: spacing.md }}
        />
        <AppButton
          title="Cancel"
          variant="secondary"
          onPress={() => navigation.goBack()}
          disabled={assign.isPending}
          style={{ marginTop: spacing.sm }}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  body: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  stitch: {
    marginVertical: spacing.lg,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: colors.brass,
    opacity: 0.5,
  },
  note: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: tint(colors.slate, 0.04),
  },
  noteHead: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  noteBody: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  error: { marginTop: spacing.md, color: colors.alert, fontSize: fontSize.secondary },
});

export default AssignMachineModal;
