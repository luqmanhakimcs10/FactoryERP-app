/**
 * Multi-photo picker for order evidence.
 *
 * Camera OR gallery by default. `cameraOnly` still exists for a future capture
 * that should be taken on the spot, but nothing in the app currently sets it —
 * the camera-only restriction was removed app-wide (including PanelCamera's
 * shift-close/QA flow, which now offers a gallery fallback too) as a deliberate
 * policy change, not because the mechanism stopped working.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';

export interface LocalPhoto {
  uri: string;
}

interface Props {
  label: string;
  photos: LocalPhoto[];
  onChange: (photos: LocalPhoto[]) => void;
  /** Single-photo mode (design sheet) vs multi (cloth photos). */
  multiple?: boolean;
  hint?: string;
  /** Hide the gallery option — the shot must be taken now, not uploaded. */
  cameraOnly?: boolean;
  /** Single-photo screens where re-capturing should read as "retake" rather
   * than "remove + add": collapses Camera/Choose-photo into one button once a
   * photo exists. Ignored when `multiple` is true. */
  retakeLabel?: string;
}

export function PhotoPicker({
  label,
  photos,
  onChange,
  multiple = true,
  hint,
  cameraOnly = false,
  retakeLabel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showRetake = !!retakeLabel && !multiple && photos.length > 0;

  async function pick(fromCamera: boolean) {
    setError(null);
    setBusy(true);
    try {
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          setError('Camera permission is needed to take a photo.');
          return;
        }
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setError('Photo library permission is needed.');
          return;
        }
      }

      const result = fromCamera
        ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({
            quality: 0.8,
            allowsMultipleSelection: multiple,
            mediaTypes: ['images'],
          });

      if (result.canceled) return;

      const picked = result.assets.map((a) => ({ uri: a.uri }));
      onChange(multiple ? [...photos, ...picked] : picked.slice(0, 1));
    } catch (e: any) {
      setError(e?.message ?? 'Could not open the picker.');
    } finally {
      setBusy(false);
    }
  }

  function remove(index: number) {
    onChange(photos.filter((_, i) => i !== index));
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}

      {photos.length > 0 ? (
        <View style={styles.grid}>
          {photos.map((p, i) => (
            <View key={`${p.uri}-${i}`} style={styles.thumbWrap}>
              <Image source={{ uri: p.uri }} style={styles.thumb} />
              <Pressable
                onPress={() => remove(i)}
                accessibilityLabel={`Remove photo ${i + 1}`}
                accessibilityRole="button"
                hitSlop={8}
                style={({ pressed }) => [styles.removeBtn, pressed && styles.pressed]}
              >
                <Ionicons name="close" size={14} color={colors.white} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        {showRetake ? (
          <Pressable
            onPress={() => remove(0)}
            disabled={busy}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Ionicons name="refresh-outline" size={18} color={colors.indigo} />
            <Text style={styles.actionText}>{retakeLabel}</Text>
          </Pressable>
        ) : (
          <>
            {/* Web has no native camera launcher via expo-image-picker. */}
            {Platform.OS !== 'web' ? (
              <Pressable
                onPress={() => pick(true)}
                disabled={busy}
                accessibilityRole="button"
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
              >
                <Ionicons name="camera-outline" size={18} color={colors.indigo} />
                <Text style={styles.actionText}>Camera</Text>
              </Pressable>
            ) : null}

            {/* Web has no camera launcher, so a camera-only field would have no way
                to capture at all there; the gallery stays available on web only. */}
            {!cameraOnly || Platform.OS === 'web' ? (
              <Pressable
                onPress={() => pick(false)}
                disabled={busy}
                accessibilityRole="button"
                style={({ pressed }) => [styles.action, pressed && styles.pressed]}
              >
                <Ionicons name="images-outline" size={18} color={colors.indigo} />
                <Text style={styles.actionText}>
                  {multiple ? 'Choose photos' : 'Choose photo'}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}

        {busy ? <ActivityIndicator color={colors.indigo} /> : null}
      </View>

      {cameraOnly && Platform.OS !== 'web' ? (
        <Text style={styles.hint}>Camera only — this one cannot be uploaded from the gallery.</Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.indigoDeep,
    marginBottom: spacing.xs,
  },
  hint: { fontSize: fontSize.caption, color: colors.slate, marginBottom: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  thumbWrap: { position: 'relative' },
  thumb: {
    width: 84,
    height: 84,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  removeBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.alert,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.indigo,
  },
  actionText: { color: colors.indigo, fontSize: fontSize.secondary, fontWeight: fontWeight.medium },
  pressed: { opacity: 0.7 },
  error: { marginTop: spacing.sm, fontSize: fontSize.caption, color: colors.alert },
});
