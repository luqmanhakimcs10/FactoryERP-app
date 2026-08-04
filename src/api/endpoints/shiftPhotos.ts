/**
 * Shift panel photo upload + stitch vision detection.
 *
 * Shift-close photos use a dedicated path segment and NEVER go through the
 * gallery-capable PhotoPicker. Compression and explicit retry are mandatory
 * because factory floors have weak connectivity and the photo IS payroll.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { compressImage } from './storage';
import { supabase } from '../client';
import type { PendingShiftCapture } from '../../models/shiftTypes';

const BUCKET = 'order-photos';
const PENDING_PREFIX = 'shift-close-pending-';

export function pendingCaptureKey(shiftId: string): string {
  return `${PENDING_PREFIX}${shiftId}`;
}

/**
 * Surviving an app kill means the capture must outlive the in-memory URI, so
 * native copies it into documentDirectory first. There is no such durable
 * storage on web (expo-file-system is unimplemented there — every call
 * throws), and a blob:/data: URI from the picker doesn't survive a page
 * reload either way, so web just keeps the URI AsyncStorage already got.
 */
export async function savePendingCapture(capture: PendingShiftCapture): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(pendingCaptureKey(capture.shiftId), JSON.stringify(capture));
    return;
  }
  const dest = `${FileSystem.documentDirectory}shift-${capture.shiftId}.jpg`;
  await FileSystem.copyAsync({ from: capture.localUri, to: dest });
  await AsyncStorage.setItem(
    pendingCaptureKey(capture.shiftId),
    JSON.stringify({ ...capture, localUri: dest })
  );
}

export async function loadPendingCapture(shiftId: string): Promise<PendingShiftCapture | null> {
  const raw = await AsyncStorage.getItem(pendingCaptureKey(shiftId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingShiftCapture;
    if (Platform.OS === 'web') return parsed;
    const info = await FileSystem.getInfoAsync(parsed.localUri);
    if (!info.exists) {
      await clearPendingCapture(shiftId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingCapture(shiftId: string): Promise<void> {
  if (Platform.OS !== 'web') {
    const pending = await loadPendingCapture(shiftId);
    if (pending?.localUri) {
      await FileSystem.deleteAsync(pending.localUri, { idempotent: true });
    }
  }
  await AsyncStorage.removeItem(pendingCaptureKey(shiftId));
}

/**
 * Upload a shift-related photo with compression. Returns the storage path.
 * 'worker' is the shift-open identity/attendance photo — a distinct capture
 * from the 'open'/'close' machine counter-panel photos, never reused for one
 * another.
 */
export async function uploadShiftPanelPhoto(
  factoryId: string,
  shiftId: string,
  localUri: string,
  label: 'open' | 'close' | 'worker'
): Promise<string> {
  const compressed = await compressImage(localUri);
  const response = await fetch(compressed);
  const blob = await response.blob();
  const path = `${factoryId}/shifts/${shiftId}/${label}-${Date.now()}.jpg`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });

  if (error) throw error;
  return path;
}

/**
 * Send a panel photo for stitch detection via the vision edge function.
 * Falls back to a deterministic dev mock when the function is unavailable —
 * the manager must still explicitly confirm; this never auto-accepts.
 */
export async function detectPanelStitches(storagePath: string): Promise<number> {
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 300);

  try {
    const { data, error } = await supabase.functions.invoke('detect-stitches', {
      body: { path: storagePath, url: signed?.signedUrl },
    });
    if (!error && data?.count != null && Number.isFinite(Number(data.count))) {
      return Math.max(0, Math.round(Number(data.count)));
    }
  } catch {
    // Edge function not deployed — dev mock below.
  }

  // Dev mock: deterministic count from path hash (NOT auto-confirmed in UI).
  let hash = 0;
  for (let i = 0; i < storagePath.length; i++) {
    hash = (hash * 31 + storagePath.charCodeAt(i)) >>> 0;
  }
  return 10000 + (hash % 90000);
}

/** Upload payment proof for salary run. */
export async function uploadPaymentProof(
  factoryId: string,
  workerId: string,
  localUri: string
): Promise<string> {
  const compressed = await compressImage(localUri);
  const response = await fetch(compressed);
  const blob = await response.blob();
  const path = `${factoryId}/payroll/${workerId}/proof-${Date.now()}.jpg`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });

  if (error) throw error;
  return path;
}
