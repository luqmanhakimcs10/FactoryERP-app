/**
 * Photo upload for order evidence (cloth photos, design sheets).
 *
 * Path convention is load-bearing: `<factory_id>/<order_id>/<file>`. The storage
 * RLS policies compare the first path segment to the caller's factory, so getting
 * this wrong doesn't just misfile a photo — it makes the upload fail. Good.
 *
 * Images are compressed client-side before upload: factory floors have weak
 * connectivity, and a raw 12MP capture is several MB for no benefit.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import { supabase } from '../client';

const BUCKET = 'order-photos';

/** Target width for uploaded evidence photos — legible without being wasteful. */
const MAX_WIDTH = 1400;
const COMPRESS = 0.7;

export async function compressImage(uri: string): Promise<string> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: MAX_WIDTH } }],
      { compress: COMPRESS, format: ImageManipulator.SaveFormat.JPEG }
    );
    return result.uri;
  } catch {
    // Compression is an optimisation, never a blocker for capturing evidence.
    return uri;
  }
}

/**
 * Upload one photo and return its storage path (not a URL — the bucket is
 * private, so callers resolve a signed URL when they need to display it).
 */
export async function uploadOrderPhoto(
  factoryId: string,
  orderId: string,
  localUri: string,
  label = 'photo'
): Promise<string> {
  const compressed = await compressImage(localUri);
  const response = await fetch(compressed);
  const blob = await response.blob();

  const path = `${factoryId}/${orderId}/${label}-${Date.now()}.jpg`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });

  if (error) throw error;
  return path;
}

/** Signed URL for a private object. */
export async function getPhotoUrl(path: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/** Signed URLs for several paths at once. */
export async function getPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!paths.length) return out;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, 3600);
  if (error || !data) return out;

  data.forEach((d, i) => {
    if (d.signedUrl) out[paths[i]] = d.signedUrl;
  });
  return out;
}
