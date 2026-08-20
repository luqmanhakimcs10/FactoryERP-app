/**
 * The finishing partner's persistent link.
 *
 * ONE URL SHAPE, TWO PLACES IT IS READ:
 *   built here, from the Masters card, to be sent to the partner once;
 *   parsed here, at app launch, to decide whether to show the partner portal
 *   instead of the login screen.
 *
 * Both `?partner=<token>` and `/partner/<token>` are accepted when parsing,
 * because a link that has been pasted into WhatsApp, forwarded, and re-typed
 * should not fail on which of the two shapes survived. Only the query form is
 * ever GENERATED — it needs nothing from the host's routing config, and this
 * app is served with a catch-all rewrite where a path segment would otherwise
 * depend on it.
 */
import { Platform } from 'react-native';

/**
 * Where the app is hosted. On web the page knows its own origin, which is
 * always right. On native there is no origin to read, so the deployment must
 * say — a link built on a phone with no base configured is a broken link, and
 * returning null here makes the card say so rather than hand over a bad URL.
 */
export function portalBaseUrl(): string | null {
  const configured = process.env.EXPO_PUBLIC_APP_BASE_URL;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/+$/, '');
  }
  return null;
}

/** The link to send a partner, or null when no base URL can be determined. */
export function buildPartnerLink(token: string | null | undefined): string | null {
  if (!token) return null;
  const base = portalBaseUrl();
  if (!base) return null;
  return `${base}/?partner=${encodeURIComponent(token)}`;
}

/**
 * The token in the current URL, if any. Web-only by nature: a native build has
 * no address bar, and the partner opens their link in a browser.
 *
 * Returns null for anything that is not a plausible token so a stray
 * `?partner=` never puts the app into a portal it cannot load.
 */
export function partnerTokenFromUrl(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const loc = window.location;
  if (!loc) return null;

  const fromQuery = new URLSearchParams(loc.search ?? '').get('partner');
  const fromPath = /\/partner\/([A-Za-z0-9_-]+)/.exec(loc.pathname ?? '')?.[1] ?? null;
  const token = (fromQuery ?? fromPath ?? '').trim();
  return token.length >= 8 ? token : null;
}
