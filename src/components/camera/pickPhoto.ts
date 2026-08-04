/**
 * Single-photo capture helper.
 *
 * Returns a local uri, or null if the user cancelled or denied permission.
 * Used by screens that want their own capture affordance rather than the
 * PhotoPicker component's standard block (order capture, design sheet).
 *
 * The shift-close flow does NOT use this — it is camera-only by design, and
 * routing it through a helper that can fall back to the gallery would weaken
 * the guarantee that the panel photo was taken at the machine.
 */
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

export async function pickPhoto(useCamera: boolean): Promise<string | null> {
  try {
    // Web has no native camera launcher via expo-image-picker, so a camera
    // request there falls back to the file picker rather than failing.
    const camera = useCamera && Platform.OS !== 'web';

    if (camera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return null;
      const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      return res.canceled ? null : (res.assets[0]?.uri ?? null);
    }

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return null;
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: 0.8,
      mediaTypes: ['images'],
    });
    return res.canceled ? null : (res.assets[0]?.uri ?? null);
  } catch {
    return null;
  }
}
