/**
 * Floor Manager — "Assign Machine" as ONE action. (Fix 3)
 *
 * WHAT THIS REPLACES
 * The old flow was: open this modal → discover no machine has an open shift →
 * be sent to the Shift Calendar → open a shift there → navigate back to the
 * Orders box → find the order again → reopen this modal → assign. Four screens
 * for one decision.
 *
 * Now it is one screen and one call (`fm_assign_machine_with_shift`, 0057):
 * pick the machine, pick the worker, take their photo, set the start time,
 * confirm. The shift is opened as part of the same transaction.
 *
 * The shift record itself is NOT skipped — per-stitch payroll reads it. The
 * counter-panel photo and opening stitch count stay on this screen but are
 * optional, so a missing baseline photo cannot block production; they are
 * marked as affecting pay so the trade-off is visible to whoever is standing
 * at the machine rather than buried in a migration comment.
 *
 * "Start Production" is deliberately NOT here. It now lives on the order row
 * alongside "Assign Machine", so both halves of the decision are visible at
 * once instead of one being reachable only through the other.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SelectField } from '../../components/forms/SelectField';
import { TextField } from '../../components/forms/TextField';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { StatusPill } from '../../components/ui/StatusPill';
import { listMachines, listFactoryWorkers } from '../../api/endpoints/shifts';
import { assignMachineWithShift } from '../../api/endpoints/stageHandover';
import { uploadShiftPanelPhoto } from '../../api/endpoints/shiftPhotos';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  tint,
} from '../../constants/theme';

/** Compact +/- stepper for an hour or minute value. */
function TimeStepper({
  value,
  max,
  onChange,
  label,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const step = (d: number) => onChange((value + d + (max + 1)) % (max + 1));
  return (
    <View style={styles.stepper} accessibilityLabel={label}>
      <Pressable onPress={() => step(-1)} hitSlop={8} accessibilityRole="button" style={styles.stepBtn}>
        <Ionicons name="remove" size={16} color={colors.indigo} />
      </Pressable>
      <Text style={styles.stepValue}>{String(value).padStart(2, '0')}</Text>
      <Pressable onPress={() => step(1)} hitSlop={8} accessibilityRole="button" style={styles.stepBtn}>
        <Ionicons name="add" size={16} color={colors.indigo} />
      </Pressable>
    </View>
  );
}

export function AssignMachineModal() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const orderId: string = route.params?.orderId;

  const now = new Date();
  const [machineId, setMachineId] = useState<string | null>(null);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [workerPhoto, setWorkerPhoto] = useState<LocalPhoto[]>([]);
  const [panelPhoto, setPanelPhoto] = useState<LocalPhoto[]>([]);
  const [openStitches, setOpenStitches] = useState('');
  const [hour, setHour] = useState(now.getHours());
  const [minute, setMinute] = useState(now.getMinutes());
  const [error, setError] = useState<string | null>(null);

  const { data: machines, isLoading: machinesLoading } = useQuery({
    queryKey: ['machines'],
    queryFn: listMachines,
  });
  const { data: workers, isLoading: workersLoading } = useQuery({
    queryKey: ['factoryWorkers'],
    queryFn: listFactoryWorkers,
  });

  const selected = (machines ?? []).find((m) => m.id === machineId);
  // A machine that already has an open shift reuses it, so worker details are
  // read-only context rather than something to re-enter.
  const reusing = !!selected?.has_open_shift;

  const assign = useMutation({
    mutationFn: async () => {
      const factoryId = profile?.factory_id ?? '';
      const tempId = `assign-${machineId}-${Date.now()}`;

      const workerPhotoUrl = await uploadShiftPanelPhoto(
        factoryId,
        tempId,
        workerPhoto[0].uri,
        'worker'
      );

      let openPhotoUrl: string | null = null;
      if (panelPhoto[0]) {
        openPhotoUrl = await uploadShiftPanelPhoto(factoryId, tempId, panelPhoto[0].uri, 'open');
      }

      const started = new Date();
      started.setHours(hour, minute, 0, 0);

      return assignMachineWithShift({
        orderId,
        machineId: machineId!,
        workerId: workerId!,
        workerPhotoUrl,
        reportedStartTime: started.toISOString(),
        openPhotoUrl,
        openStitches: Number(openStitches) || 0,
      });
    },
    onSuccess: () => {
      for (const k of ['orders', 'machines', 'machineContext', 'shiftCloseQueue']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
      queryClient.invalidateQueries({ queryKey: ['order', orderId] });
      // Back to the order row, where "Start Production" is already waiting
      // next to the now-assigned machine.
      navigation.goBack();
    },
    onError: (e) => setError(describeDbError(e, 'Assign machine')),
  });

  const ready = !!machineId && (reusing || !!workerId) && workerPhoto.length > 0;

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
          Machine, worker, photo and start time — all in this one step. The shift is opened for
          you; there is no separate Shift Calendar visit.
        </Text>
        <View style={styles.stitch} />

        <SelectField
          label="Machine"
          value={machineId}
          onChange={setMachineId}
          required
          options={(machines ?? []).map((m) => ({
            value: m.id,
            label: m.has_open_shift ? `${m.name} — shift already open` : m.name,
          }))}
          emptyHint="No machines are assigned to you yet."
        />

        {reusing ? (
          <View style={styles.reuseCard}>
            <StatusPill label="Shift already open" color={colors.success} />
            <Text style={styles.reuseText}>
              {selected?.worker_name ?? 'A worker'} is already on {selected?.name}
              {selected?.order_code ? ` for ${selected.order_code}` : ''}. That shift will be
              reused — take the worker photo to confirm who is on the machine now.
            </Text>
          </View>
        ) : (
          <SelectField
            label="Worker"
            value={workerId}
            onChange={setWorkerId}
            required
            loading={workersLoading}
            options={(workers ?? []).map((w) => ({ value: w.id, label: w.display_name }))}
            emptyHint="No active workers on file."
          />
        )}

        <PhotoPicker
          label="Worker photo"
          hint="Required — confirms who is physically at the machine for this shift."
          photos={workerPhoto}
          onChange={setWorkerPhoto}
          multiple={false}
          retakeLabel="Retake"
        />

        <Text style={styles.fieldLabel}>Shift start time</Text>
        <View style={styles.timeRow}>
          <TimeStepper value={hour} max={23} onChange={setHour} label="Hour" />
          <Text style={styles.colon}>:</Text>
          <TimeStepper value={minute} max={59} onChange={setMinute} label="Minute" />
        </View>

        {!reusing ? (
          <View style={styles.optional}>
            <Text style={styles.optionalHead}>Counter baseline (optional — affects pay)</Text>
            <Text style={styles.optionalBody}>
              Payroll counts stitches from this reading to the shift-close reading. Leave it out
              and this shift starts from zero, which over-credits whatever was already on the
              counter.
            </Text>
            <PhotoPicker
              label="Machine counter-panel photo"
              photos={panelPhoto}
              onChange={setPanelPhoto}
              multiple={false}
              retakeLabel="Retake"
            />
            <TextField
              label="Opening stitch count"
              value={openStitches}
              onChangeText={setOpenStitches}
              numeric
              placeholder="0"
            />
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title="Assign Machine"
          variant="brass"
          disabled={!ready}
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
  fieldLabel: {
    marginTop: spacing.sm,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.indigoDeep,
    marginBottom: spacing.sm,
  },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: tint(colors.indigo, 0.1),
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    minWidth: 30,
    textAlign: 'center',
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  colon: { fontSize: fontSize.title, color: colors.slate },
  reuseCard: {
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.success,
    backgroundColor: tint(colors.success, 0.08),
  },
  reuseText: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  optional: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: tint(colors.slate, 0.04),
  },
  optionalHead: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  optionalBody: {
    marginTop: 2,
    marginBottom: spacing.md,
    fontSize: fontSize.caption,
    color: colors.slate,
    lineHeight: 18,
  },
  error: { marginTop: spacing.md, color: colors.alert, fontSize: fontSize.secondary },
});

export default AssignMachineModal;
