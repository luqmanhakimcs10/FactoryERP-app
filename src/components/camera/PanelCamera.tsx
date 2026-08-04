/**
 * Panel capture for shift close / open and initial QA.
 *
 * Live camera via expo-camera is the primary path (the photo IS the payroll /
 * QA record). A "Choose from gallery" fallback was added deliberately — this
 * removes an anti-fraud control that existed by design (a gallery picker lets
 * someone submit an old or unrelated photo instead of a live one), a tradeoff
 * made knowingly, not an oversight. Camera stays the default and primary
 * action everywhere this component is used.
 */
import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, fontWeight, radius } from '../../constants/theme';

interface Props {
  onCapture: (uri: string) => void;
  onCancel?: () => void;
  hint?: string;
}

async function pickFromGallery(
  onCapture: (uri: string) => void,
  setError: (e: string | null) => void
) {
  setError(null);
  try {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library permission is needed.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.85,
      mediaTypes: ['images'],
    });
    if (result.canceled) return;
    const uri = result.assets[0]?.uri;
    if (uri) onCapture(uri);
  } catch {
    setError('Could not open the gallery — try again.');
  }
}

function GalleryButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.galleryBtn} accessibilityRole="button">
      <Ionicons name="images-outline" size={18} color={colors.white} />
      <Text style={styles.galleryBtnText}>Choose from gallery</Text>
    </Pressable>
  );
}

export function PanelCamera({ onCapture, onCancel, hint }: Props) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.center}>
        <Ionicons name="camera-outline" size={48} color={colors.slate} />
        <Text style={styles.webMsg}>
          Live camera capture requires a mobile device. Choose a photo from your files
          instead, or run on iOS or Android to capture live.
        </Text>
        <Pressable
          onPress={() => pickFromGallery(onCapture, setError)}
          style={styles.permBtn}
        >
          <Text style={styles.permBtnText}>Choose from gallery</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {onCancel ? (
          <Pressable onPress={onCancel} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>Go back</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Ionicons name="camera-outline" size={48} color={colors.slate} />
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permBody}>
          Grant camera permission for a live panel photo, or choose one from the gallery.
        </Text>
        <Pressable onPress={requestPermission} style={styles.permBtn}>
          <Text style={styles.permBtnText}>Allow camera</Text>
        </Pressable>
        <Pressable
          onPress={() => pickFromGallery(onCapture, setError)}
          style={styles.permBtnSecondary}
        >
          <Text style={styles.permBtnSecondaryText}>Choose from gallery</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {onCancel ? (
          <Pressable onPress={onCancel} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>Go back</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  async function capture() {
    if (!cameraRef.current || capturing) return;
    setError(null);
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85 });
      if (photo?.uri) onCapture(photo.uri);
      else setError('Capture failed — try again.');
    } catch {
      setError('Capture failed — try again.');
    } finally {
      setCapturing(false);
    }
  }

  return (
    <View style={styles.root}>
      <CameraView ref={cameraRef} style={styles.camera} facing="back">
        <View style={styles.overlay}>
          {onCancel ? (
            <Pressable onPress={onCancel} style={styles.backBtn} accessibilityRole="button">
              <Ionicons name="close" size={28} color={colors.white} />
            </Pressable>
          ) : null}

          <View style={styles.frame}>
            <Text style={styles.frameHint}>
              {hint ?? 'Frame the machine counter panel in the viewfinder'}
            </Text>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            onPress={capture}
            disabled={capturing}
            accessibilityRole="button"
            accessibilityLabel="Capture panel photo"
            style={({ pressed }) => [
              styles.shutter,
              pressed && styles.shutterPressed,
              capturing && styles.shutterDisabled,
            ]}
          >
            {capturing ? (
              <ActivityIndicator color={colors.indigoDeep} />
            ) : (
              <View style={styles.shutterInner} />
            )}
          </Pressable>

          <GalleryButton onPress={() => pickFromGallery(onCapture, setError)} />
        </View>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.indigoDeep },
  camera: { flex: 1 },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    backgroundColor: 'rgba(21, 31, 56, 0.25)',
  },
  backBtn: {
    alignSelf: 'flex-start',
    padding: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  frame: {
    alignSelf: 'center',
    borderWidth: 2,
    borderColor: colors.brass,
    borderRadius: radius.md,
    padding: spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.35)',
    maxWidth: '90%',
  },
  frameHint: {
    color: colors.white,
    fontSize: fontSize.secondary,
    textAlign: 'center',
    fontWeight: fontWeight.medium,
  },
  shutter: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  shutterPressed: { opacity: 0.8 },
  shutterDisabled: { opacity: 0.5 },
  shutterInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.white,
  },
  error: {
    color: colors.alert,
    textAlign: 'center',
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
  },
  center: {
    flex: 1,
    backgroundColor: colors.indigoDeep,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  webMsg: {
    color: colors.white,
    fontSize: fontSize.body,
    textAlign: 'center',
    lineHeight: 24,
  },
  permTitle: {
    color: colors.white,
    fontSize: fontSize.title,
    fontWeight: fontWeight.semibold,
  },
  permBody: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fontSize.secondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  permBtn: {
    marginTop: spacing.md,
    backgroundColor: colors.brass,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  permBtnText: {
    color: colors.indigoDeep,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
  },
  permBtnSecondary: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  permBtnSecondaryText: {
    color: colors.white,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
  },
  cancelBtn: { marginTop: spacing.lg, padding: spacing.md },
  cancelText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.secondary },
  galleryBtn: {
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  galleryBtnText: { color: colors.white, fontSize: fontSize.secondary, fontWeight: fontWeight.medium },
});
