/**
 * "Send this to someone" — one call that does the right thing per platform.
 *
 * No new dependency: `expo-clipboard` is not in this project, and the two
 * built-ins between them cover every target. On web the Clipboard API is what
 * a person expects from a Copy button; on a phone the share sheet is, because
 * the partner link exists to be sent to a partner in WhatsApp.
 *
 * Returns what actually happened so the caller can say "Copied" or "Shared"
 * rather than guessing — and `false` when neither route was available, so a
 * button never claims success it did not have.
 */
import { Platform, Share } from 'react-native';

export type ShareOutcome = 'copied' | 'shared' | 'failed';

export async function shareOrCopy(text: string, dialogTitle?: string): Promise<ShareOutcome> {
  if (Platform.OS === 'web') {
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(text);
        return 'copied';
      }
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission).
      // Fall through to Share, which react-native-web maps to navigator.share
      // where it exists.
    }
  }

  try {
    const result = await Share.share({ message: text, title: dialogTitle });
    // `dismissedAction` means the person closed the sheet without sending.
    return result.action === Share.dismissedAction ? 'failed' : 'shared';
  } catch {
    return 'failed';
  }
}
