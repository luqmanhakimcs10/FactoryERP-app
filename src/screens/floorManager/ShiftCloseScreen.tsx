/**
 * Machine Shift-Close — the payroll record screen.
 *
 * Sequence: camera → compress/upload (with retry) → detect → review overlay →
 * confirm or correct → downtime → close. Flag idle is an exception path that
 * skips ledger posting. Pending captures survive app kills / connectivity loss.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { PanelCamera } from '../../components/camera/PanelCamera';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { closeShift, flagShiftIdle, getShift } from '../../api/endpoints/shifts';
import {
  clearPendingCapture,
  detectPanelStitches,
  loadPendingCapture,
  savePendingCapture,
  uploadShiftPanelPhoto,
} from '../../api/endpoints/shiftPhotos';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import type { ShiftCloseStep } from '../../models/shiftTypes';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  fontFamily,
  radius,
} from '../../constants/theme';

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm', onPress: onConfirm },
  ]);
}

export function ShiftCloseScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { factory } = useAuth();
  const shiftId: string = route.params?.shiftId;
  const factoryId = factory?.id ?? '';

  const [step, setStep] = useState<ShiftCloseStep>('camera');
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [detectedCount, setDetectedCount] = useState<number | null>(null);
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const [correctInput, setCorrectInput] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const [downtimeMinutes, setDowntimeMinutes] = useState('');
  const [downtimeReason, setDowntimeReason] = useState('');
  const [hasDowntime, setHasDowntime] = useState<boolean | null>(null);

  const { data: shift, isLoading } = useQuery({
    queryKey: ['shift', shiftId],
    queryFn: () => getShift(shiftId),
    enabled: !!shiftId,
  });

  const machineName =
    (shift?.machines as { name?: string } | null)?.name ?? 'Machine';
  const workerName =
    (shift?.profiles as { display_name?: string } | null)?.display_name ?? 'Worker';
  const openStitches = shift?.open_stitches ?? 0;

  // Resume pending capture after app kill or connectivity loss.
  useEffect(() => {
    if (!shiftId) return;
    (async () => {
      const pending = await loadPendingCapture(shiftId);
      if (!pending) return;
      setLocalUri(pending.localUri);
      if (pending.storagePath) setStoragePath(pending.storagePath);
      if (pending.detectedCount != null) setDetectedCount(pending.detectedCount);
      if (pending.step === 'detect' && pending.storagePath && pending.detectedCount != null) {
        setStep('review');
      } else if (pending.step === 'detect' && pending.storagePath) {
        setStep('detecting');
        runDetection(pending.storagePath, pending.localUri);
      } else {
        setStep('uploading');
        setUploadError('Upload interrupted — tap Retry to continue.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftId]);

  const runUpload = useCallback(
    async (uri: string) => {
      if (!factoryId) return;
      setUploading(true);
      setUploadError(null);
      setStep('uploading');
      await savePendingCapture({
        shiftId,
        localUri: uri,
        step: 'upload',
        savedAt: new Date().toISOString(),
      });
      try {
        const path = await uploadShiftPanelPhoto(factoryId, shiftId, uri, 'close');
        setStoragePath(path);
        await savePendingCapture({
          shiftId,
          localUri: uri,
          step: 'detect',
          storagePath: path,
          savedAt: new Date().toISOString(),
        });
        setUploading(false);
        await runDetection(path, uri);
      } catch (e) {
        setUploading(false);
        setUploadError(describeDbError(e, 'Photo upload'));
      }
    },
    [factoryId, shiftId]
  );

  const runDetection = useCallback(
    async (path: string, uri: string) => {
      setDetecting(true);
      setDetectError(null);
      setStep('detecting');
      try {
        const count = await detectPanelStitches(path);
        setDetectedCount(count);
        await savePendingCapture({
          shiftId,
          localUri: uri,
          step: 'detect',
          storagePath: path,
          detectedCount: count,
          savedAt: new Date().toISOString(),
        });
        setDetecting(false);
        setStep('review');
      } catch (e) {
        setDetecting(false);
        setDetectError(describeDbError(e, 'Stitch detection'));
      }
    },
    [shiftId]
  );

  function onCapture(uri: string) {
    setLocalUri(uri);
    setDetectedCount(null);
    setConfirmedCount(null);
    setCorrectInput('');
    runUpload(uri);
  }

  function onConfirmCount() {
    if (detectedCount == null) return;
    setConfirmedCount(detectedCount);
    setStep('downtime');
    setHasDowntime(null);
  }

  function onCorrectSubmit() {
    const n = parseInt(correctInput, 10);
    if (!Number.isFinite(n) || n < 0) {
      setCloseError('Enter a valid stitch count.');
      return;
    }
    if (n < openStitches) {
      setCloseError(`Count cannot be less than open count (${openStitches}).`);
      return;
    }
    setCloseError(null);
    setConfirmedCount(n);
    setStep('downtime');
    setHasDowntime(null);
  }

  const idleMutation = useMutation({
    mutationFn: () =>
      flagShiftIdle(shiftId, storagePath ?? undefined, detectedCount ?? undefined),
    onSuccess: async () => {
      await clearPendingCapture(shiftId);
      invalidateAndGoBack();
    },
    onError: (e) => setCloseError(describeDbError(e, 'Shift')),
  });

  const closeMutation = useMutation({
    mutationFn: () =>
      closeShift({
        shiftId,
        closePhotoUrl: storagePath!,
        detectedStitches: detectedCount!,
        confirmedStitches: confirmedCount!,
        downtimeMinutes: hasDowntime ? Number(downtimeMinutes) || 0 : null,
        downtimeReason: hasDowntime ? downtimeReason.trim() : null,
      }),
    onSuccess: async () => {
      await clearPendingCapture(shiftId);
      invalidateAndGoBack();
    },
    onError: (e) => setCloseError(describeDbError(e, 'Shift close')),
  });

  function invalidateAndGoBack() {
    for (const k of ['shifts', 'shift', 'machines', 'shiftCloseQueue', 'salaryRun']) {
      queryClient.invalidateQueries({ queryKey: [k] });
    }
    navigation.goBack();
  }

  function onFlagIdle() {
    confirmAction(
      'Flag idle machine?',
      'This shift will be excluded from payroll. No stitch count will be posted.',
      () => idleMutation.mutate()
    );
  }

  function onCloseShift() {
    if (!storagePath || detectedCount == null || confirmedCount == null) return;
    if (hasDowntime) {
      const mins = Number(downtimeMinutes);
      if (!Number.isFinite(mins) || mins <= 0 || !downtimeReason.trim()) {
        setCloseError('Enter downtime minutes and a reason, or select No downtime.');
        return;
      }
    }
    setCloseError(null);
    setStep('closing');
    closeMutation.mutate();
  }

  if (isLoading || !shift) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (shift.status !== 'open') {
    return (
      <View style={styles.loading}>
        <Text style={styles.closedMsg}>This shift is already closed.</Text>
        <AppButton title="Go back" onPress={() => navigation.goBack()} variant="secondary" />
      </View>
    );
  }

  // ---- Camera step ----
  if (step === 'camera') {
    return (
      <View style={styles.fullBleed}>
        <View style={styles.cameraHeader}>
          <Text style={styles.cameraTitle}>{machineName}</Text>
          <Text style={styles.cameraSub}>{workerName} · Open {openStitches.toLocaleString()}</Text>
        </View>
        <PanelCamera
          hint="Capture the machine counter panel"
          onCapture={onCapture}
          onCancel={() => navigation.goBack()}
        />
      </View>
    );
  }

  // ---- Upload / detect status ----
  if (step === 'uploading' || step === 'detecting') {
    return (
      <View style={styles.fullBleed}>
        <StatusPanel
          localUri={localUri}
          title={step === 'uploading' ? 'Uploading photo…' : 'Detecting stitches…'}
          subtitle={
            step === 'uploading'
              ? 'Compressing and sending to server. Do not leave this screen.'
              : 'Vision API is reading the counter. Manager confirmation still required.'
          }
          loading
          error={uploadError ?? detectError}
          onRetry={
            uploadError && localUri
              ? () => runUpload(localUri)
              : detectError && storagePath && localUri
                ? () => runDetection(storagePath, localUri)
                : undefined
          }
        />
      </View>
    );
  }

  // ---- Review with overlay count ----
  if (step === 'review' || step === 'correct') {
    const displayCount = step === 'correct' ? null : detectedCount;
    return (
      <View style={styles.fullBleed}>
        <View style={styles.reviewPhotoWrap}>
          {localUri ? (
            <Image source={{ uri: localUri }} style={styles.reviewPhoto} resizeMode="cover" />
          ) : null}
          {displayCount != null ? (
            <View style={styles.countOverlay}>
              <Text style={styles.countLabel}>Detected</Text>
              <Text style={styles.countValue}>{displayCount.toLocaleString()}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.reviewActions}>
          <Text style={styles.reviewMeta}>
            {machineName} · {workerName} · Open {openStitches.toLocaleString()}
          </Text>

          {step === 'correct' ? (
            <View style={styles.correctBlock}>
              <Text style={styles.correctHint}>
                Detected: {detectedCount?.toLocaleString() ?? '—'}. Enter the actual counter
                reading.
              </Text>
              <TextField
                label="Corrected stitch count"
                value={correctInput}
                onChangeText={setCorrectInput}
                numeric
                mono
                required
              />
              {closeError ? <Text style={styles.errText}>{closeError}</Text> : null}
              <AppButton title="Apply correction" onPress={onCorrectSubmit} variant="brass" />
              <AppButton
                title="Back to detected count"
                onPress={() => {
                  setStep('review');
                  setCloseError(null);
                }}
                variant="secondary"
              />
            </View>
          ) : (
            <>
              <AppButton title="Confirm count" onPress={onConfirmCount} variant="brass" />
              <AppButton
                title="Correct count"
                onPress={() => {
                  setStep('correct');
                  setCorrectInput(detectedCount != null ? String(detectedCount) : '');
                }}
                variant="secondary"
              />
              <Pressable onPress={onFlagIdle} style={styles.idleLink} accessibilityRole="button">
                <Text style={styles.idleText}>Flag idle machine or counter reset</Text>
              </Pressable>
              {idleMutation.isPending ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.sm }} />
              ) : null}
              {closeError ? <Text style={styles.errText}>{closeError}</Text> : null}
            </>
          )}
        </View>
      </View>
    );
  }

  // ---- Downtime confirmation ----
  if (step === 'downtime') {
    const delta = (confirmedCount ?? 0) - openStitches;
    return (
      <ScrollView style={styles.downtimeScroll} contentContainerStyle={styles.downtimeContent}>
        <Text style={styles.downtimeTitle}>Downtime for this shift?</Text>
        <Text style={styles.downtimeMeta}>
          Confirmed close: {confirmedCount?.toLocaleString()} · Shift stitches:{' '}
          {delta.toLocaleString()}
        </Text>

        <View style={styles.downtimeChips}>
          <Pressable
            onPress={() => setHasDowntime(false)}
            style={[styles.chip, hasDowntime === false && styles.chipOn]}
          >
            <Text style={[styles.chipText, hasDowntime === false && styles.chipTextOn]}>
              No downtime
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setHasDowntime(true)}
            style={[styles.chip, hasDowntime === true && styles.chipOn]}
          >
            <Text style={[styles.chipText, hasDowntime === true && styles.chipTextOn]}>
              Log downtime
            </Text>
          </Pressable>
        </View>

        {hasDowntime ? (
          <>
            <TextField
              label="Duration (minutes)"
              value={downtimeMinutes}
              onChangeText={setDowntimeMinutes}
              numeric
              required
            />
            <TextField
              label="Reason"
              value={downtimeReason}
              onChangeText={setDowntimeReason}
              multiline
              required
            />
          </>
        ) : null}

        {closeError ? <Text style={styles.errText}>{closeError}</Text> : null}

        <AppButton
          title="Close shift"
          onPress={onCloseShift}
          variant="brass"
          disabled={hasDowntime === null}
          loading={closeMutation.isPending}
        />
        <AppButton
          title="Back"
          onPress={() => setStep('review')}
          variant="secondary"
          disabled={closeMutation.isPending}
        />
      </ScrollView>
    );
  }

  // ---- Closing ----
  return (
    <View style={styles.fullBleed}>
      <StatusPanel
        localUri={localUri}
        title="Closing shift…"
        subtitle="Posting to worker ledger."
        loading
      />
    </View>
  );
}

function StatusPanel({
  localUri,
  title,
  subtitle,
  loading,
  error,
  onRetry,
}: {
  localUri: string | null;
  title: string;
  subtitle?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.statusRoot}>
      {localUri ? (
        <Image source={{ uri: localUri }} style={styles.statusPhoto} resizeMode="cover" />
      ) : null}
      <View style={styles.statusOverlay}>
        {loading ? <ActivityIndicator color={colors.primary} size="large" /> : null}
        <Text style={styles.statusTitle}>{title}</Text>
        {subtitle ? <Text style={styles.statusSub}>{subtitle}</Text> : null}
        {error ? (
          <>
            <Text style={styles.errText}>{error}</Text>
            {onRetry ? (
              <AppButton title="Retry upload" onPress={onRetry} variant="brass" style={{ marginTop: spacing.md }} />
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fullBleed: { flex: 1, backgroundColor: colors.indigoDeep },
  loading: {
    flex: 1,
    backgroundColor: colors.indigoDeep,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
  },
  closedMsg: { color: colors.white, fontSize: fontSize.body, textAlign: 'center' },
  cameraHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    padding: spacing.lg,
    paddingTop: spacing.xxl,
    backgroundColor: 'rgba(21,31,56,0.7)',
  },
  cameraTitle: {
    color: colors.white,
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
  },
  cameraSub: { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.secondary, marginTop: 2 },
  reviewPhotoWrap: { flex: 1, position: 'relative' },
  reviewPhoto: { width: '100%', height: '100%' },
  countOverlay: {
    ...(StyleSheet.absoluteFill as object),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(21,31,56,0.45)',
  },
  countLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.xs,
  },
  countValue: {
    color: colors.white,
    fontSize: 56,
    fontWeight: fontWeight.semibold,
    fontFamily: fontFamily.mono,
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  reviewActions: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
    backgroundColor: colors.indigoDeep,
  },
  reviewMeta: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.caption,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  correctBlock: { gap: spacing.sm },
  correctHint: { color: colors.white, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  idleLink: { alignSelf: 'center', paddingVertical: spacing.sm },
  idleText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: fontSize.caption,
    textDecorationLine: 'underline',
  },
  errText: {
    color: colors.alert,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
  downtimeScroll: { flex: 1, backgroundColor: colors.canvas },
  downtimeContent: { padding: spacing.lg, gap: spacing.md },
  downtimeTitle: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  downtimeMeta: { fontSize: fontSize.secondary, color: colors.slate, fontFamily: fontFamily.mono },
  downtimeChips: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.secondary, color: colors.slate, fontWeight: fontWeight.medium },
  chipTextOn: { color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  statusRoot: { flex: 1, position: 'relative' },
  statusPhoto: { ...(StyleSheet.absoluteFill as object), opacity: 0.4 },
  statusOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
    backgroundColor: 'rgba(21,31,56,0.75)',
  },
  statusTitle: {
    color: colors.white,
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',
  },
  statusSub: { color: 'rgba(255,255,255,0.75)', fontSize: fontSize.secondary, textAlign: 'center' },
});
