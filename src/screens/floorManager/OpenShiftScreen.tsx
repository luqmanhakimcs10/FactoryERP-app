/**
 * Floor Manager — open shift / machine assignment.
 *
 * Assigns a worker and order to a machine. Shows previous job card lines as
 * reference context. Inherits open photo/stitches from the last closed shift when
 * available; otherwise captures a live panel photo for the open baseline.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Image,
  Pressable,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SelectField } from '../../components/forms/SelectField';
import { PanelCamera } from '../../components/camera/PanelCamera';
import { PhotoPicker, type LocalPhoto } from '../../components/camera/PhotoPicker';
import { StitchLine } from '../../components/ui/StitchLine';
import { Ionicons } from '@expo/vector-icons';
import {
  getMachineContext,
  listAssignableOrders,
  listFactoryWorkers,
  openShift,
} from '../../api/endpoints/shifts';
import {
  detectPanelStitches,
  uploadShiftPanelPhoto,
} from '../../api/endpoints/shiftPhotos';
import { getPhotoUrl } from '../../api/endpoints/storage';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  fontFamily,
  radius,
} from '../../constants/theme';

type Phase = 'form' | 'camera' | 'uploading';

export function OpenShiftScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { factory } = useAuth();

  const machineId: string = route.params?.machineId;
  const machineName: string = route.params?.machineName ?? 'Machine';
  const existingShiftId: string | null = route.params?.openShiftId ?? null;

  const [workerId, setWorkerId] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [inheritedPhotoUrl, setInheritedPhotoUrl] = useState<string | null>(null);
  const [workerPhoto, setWorkerPhoto] = useState<LocalPhoto[]>([]);
  const now0 = new Date();
  const [startHour, setStartHour] = useState(now0.getHours());
  const [startMinute, setStartMinute] = useState(now0.getMinutes());

  const { data: context, isLoading: ctxLoading } = useQuery({
    queryKey: ['machineContext', machineId],
    queryFn: () => getMachineContext(machineId),
    enabled: !!machineId,
  });

  const { data: workers, isLoading: workersLoading } = useQuery({
    queryKey: ['factoryWorkers'],
    queryFn: listFactoryWorkers,
  });

  const { data: orders, isLoading: ordersLoading } = useQuery({
    queryKey: ['assignableOrders'],
    queryFn: listAssignableOrders,
  });

  // Load signed URL for inherited open photo preview.
  React.useEffect(() => {
    const path = context?.inherited_open_photo_url;
    if (!path) {
      setInheritedPhotoUrl(null);
      return;
    }
    getPhotoUrl(path).then(setInheritedPhotoUrl);
  }, [context?.inherited_open_photo_url]);

  const openMutation = useMutation({
    mutationFn: async (params: {
      openPhotoUrl: string;
      openStitches: number;
    }) => {
      if (!workerPhoto[0] || !factory?.id) throw new Error('Take a photo of the worker first.');
      const tempId = `open-${machineId}-${Date.now()}`;
      const workerPhotoUrl = await uploadShiftPanelPhoto(factory.id, tempId, workerPhoto[0].uri, 'worker');
      const reportedStartTime = new Date();
      reportedStartTime.setHours(startHour, startMinute, 0, 0);
      return openShift({
        machineId,
        workerId: workerId!,
        orderId,
        openPhotoUrl: params.openPhotoUrl,
        openStitches: params.openStitches,
        workerPhotoUrl,
        reportedStartTime: reportedStartTime.toISOString(),
      });
    },
    onSuccess: () => {
      for (const k of ['machines', 'shiftCloseQueue', 'machineContext']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
      navigation.goBack();
    },
    onError: (e) => setError(describeDbError(e, 'Shift')),
  });

  async function submitWithInherited() {
    if (!workerId) {
      setError('Select a worker.');
      return;
    }
    if (!workerPhoto[0]) {
      setError('Take a photo of the worker.');
      return;
    }
    if (!context?.inherited_open_photo_url) {
      setError('No inherited open photo — capture the panel first.');
      return;
    }
    setError(null);
    openMutation.mutate({
      openPhotoUrl: context.inherited_open_photo_url,
      openStitches: context.inherited_open_stitches ?? 0,
    });
  }

  async function onCapture(uri: string) {
    if (!workerId || !factory?.id) return;
    setPhase('uploading');
    setError(null);
    try {
      // Use a temp id for upload path; shift doesn't exist yet.
      const tempId = `open-${machineId}-${Date.now()}`;
      const path = await uploadShiftPanelPhoto(factory.id, tempId, uri, 'open');
      const stitches = await detectPanelStitches(path);
      openMutation.mutate({ openPhotoUrl: path, openStitches: stitches });
    } catch (e) {
      setPhase('form');
      setError(describeDbError(e, 'Open photo'));
    }
  }

  if (ctxLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  if (existingShiftId || context?.has_open_shift) {
    return (
      <Screen>
        <Text style={styles.title}>{machineName}</Text>
        <Text style={styles.body}>
          This machine already has an open shift. Close it from the shift-close walk list
          before assigning a new one.
        </Text>
        <AppButton
          title="Go to shift close"
          onPress={() => navigation.navigate('ShiftCloseQueue')}
          variant="brass"
        />
        <AppButton title="Back" onPress={() => navigation.goBack()} variant="secondary" />
      </Screen>
    );
  }

  if (phase === 'camera') {
    return (
      <View style={styles.cameraRoot}>
        <PanelCamera
          hint="Capture the counter panel for shift open baseline"
          onCapture={onCapture}
          onCancel={() => setPhase('form')}
        />
      </View>
    );
  }

  if (phase === 'uploading' || openMutation.isPending) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} size="large" />
        <Text style={styles.uploading}>Opening shift…</Text>
      </Screen>
    );
  }

  const hasInherited = !!context?.inherited_open_photo_url;
  const prevLines = context?.previous_job_card_lines ?? [];

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{machineName}</Text>
        <Text style={styles.sub}>Assign worker and order for this shift</Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {prevLines.length > 0 ? (
          <View style={styles.refCard}>
            <Text style={styles.refLabel}>Previous order reference</Text>
            <Text style={styles.refHint}>
              Needle numbers and thread codes from the last job on this machine.
            </Text>
            {prevLines.map((line) => (
              <Text key={line.needle_number} style={styles.refLine}>
                Needle {line.needle_number}:{' '}
                <Text style={styles.mono}>{line.thread_color_code}</Text>
                {line.stitch_count != null ? ` · ${line.stitch_count} st` : ''}
              </Text>
            ))}
          </View>
        ) : null}

        {hasInherited ? (
          <View style={styles.refCard}>
            <Text style={styles.refLabel}>Inherited open baseline</Text>
            <Text style={styles.refHint}>
              Close photo from the previous shift becomes this shift's open count (
              {context!.inherited_open_stitches.toLocaleString()} stitches).
            </Text>
            {inheritedPhotoUrl ? (
              <Image source={{ uri: inheritedPhotoUrl }} style={styles.inheritedPhoto} />
            ) : null}
          </View>
        ) : null}

        <SelectField
          label="Worker"
          value={workerId}
          options={(workers ?? []).map((w) => ({ value: w.id, label: w.display_name }))}
          onChange={setWorkerId}
          loading={workersLoading}
          required
          emptyHint="No active workers in this factory."
        />

        <SelectField
          label="Order"
          value={orderId}
          options={(orders ?? []).map((o: any) => ({
            value: o.id,
            label: o.order_code,
          }))}
          onChange={setOrderId}
          loading={ordersLoading}
          allowClear
          clearLabel="No order"
          emptyHint="No orders in production."
        />

        {/* Distinct from the machine counter-panel photo below — this confirms
            the worker is physically present, not the stitch baseline. */}
        <PhotoPicker
          label="Worker photo"
          hint="Identity/attendance confirmation for this shift."
          photos={workerPhoto}
          onChange={setWorkerPhoto}
          multiple={false}
        />

        <Text style={styles.refLabel}>Shift start time</Text>
        <View style={styles.timeRow}>
          <TimeStepper
            value={startHour}
            max={23}
            onChange={setStartHour}
            format={(v) => String(v).padStart(2, '0')}
          />
          <Text style={styles.timeColon}>:</Text>
          <TimeStepper
            value={startMinute}
            max={59}
            onChange={setStartMinute}
            format={(v) => String(v).padStart(2, '0')}
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {hasInherited ? (
          <AppButton title="Open shift" onPress={submitWithInherited} variant="brass" />
        ) : (
          <AppButton
            title="Capture open panel photo"
            onPress={() => {
              if (!workerId) {
                setError('Select a worker first.');
                return;
              }
              if (!workerPhoto[0]) {
                setError('Take a photo of the worker first.');
                return;
              }
              setError(null);
              setPhase('camera');
            }}
            variant="brass"
          />
        )}

        <AppButton title="Cancel" onPress={() => navigation.goBack()} variant="secondary" />
      </ScrollView>
    </Screen>
  );
}

/** Dependency-free +/- stepper — no native date/time picker exists elsewhere in this repo. */
function TimeStepper({
  value,
  max,
  onChange,
  format,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  const step = (delta: number) => onChange((value + delta + (max + 1)) % (max + 1));
  return (
    <View style={styles.stepper}>
      <Pressable onPress={() => step(-1)} accessibilityRole="button" accessibilityLabel="Decrease" hitSlop={8} style={styles.stepBtn}>
        <Ionicons name="chevron-down" size={18} color={colors.indigo} />
      </Pressable>
      <Text style={styles.stepValue}>{format(value)}</Text>
      <Pressable onPress={() => step(1)} accessibilityRole="button" accessibilityLabel="Increase" hitSlop={8} style={styles.stepBtn}>
        <Ionicons name="chevron-up" size={18} color={colors.indigo} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  sub: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  stitch: { marginVertical: spacing.lg },
  refCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.xs,
  },
  refLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  refHint: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.sm },
  refLine: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.lg },
  timeColon: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  stepper: { alignItems: 'center', gap: 2 },
  stepBtn: { padding: spacing.xs, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  stepValue: { fontFamily: fontFamily.mono, fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep, minWidth: 40, textAlign: 'center' },
  mono: { fontFamily: fontFamily.mono },
  inheritedPhoto: {
    width: '100%',
    height: 160,
    borderRadius: radius.md,
    marginTop: spacing.sm,
    backgroundColor: colors.border,
  },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.md },
  body: { fontSize: fontSize.body, color: colors.slate, marginVertical: spacing.lg, lineHeight: 24 },
  uploading: { marginTop: spacing.lg, textAlign: 'center', color: colors.slate },
  cameraRoot: { flex: 1, backgroundColor: colors.indigoDeep },
});
