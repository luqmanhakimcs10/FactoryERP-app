/**
 * Factory ERP — Design System tokens.
 *
 * Palette: deep teal / coral on a soft off-white, with a distinct monospace
 * voice for codes & reference numbers.
 *
 * Naming: the canonical tokens are semantic (`primary`, `accent`, `bg`, `ink`).
 * The older identity-named tokens (`indigo`, `brass`, `canvas`, `slate`) are
 * kept as ALIASES pointing at the new values so the ~1,500 existing call sites
 * keep working and re-theme in place. Prefer the semantic names in new code.
 */

// ---------------------------------------------------------------------------
// Canonical palette
// ---------------------------------------------------------------------------

/** Deep teal — headers, primary buttons, role badges, active nav. */
const PRIMARY = '#0D7377';
/** A darker teal for pressed/strong-contrast primary surfaces. */
const PRIMARY_DEEP = '#0A5C5F';
/** Coral — accents, alerts, CTAs, "needs attention". */
const ACCENT = '#FF6B4A';
/** Soft off-white app background. */
const BG = '#F5F9F8';
/** Near-black primary text. */
const INK = '#1B2E2D';
/** Secondary text. */
const INK_MUTED = '#6B7B7A';
/** Tertiary / placeholder text. */
const INK_SUBTLE = '#8B9A99';
/** Light border on white card surfaces. */
const BORDER = '#E3EFEE';
/** Status pill tints. */
const TINT_TEAL = '#E3F5F3';
const TINT_CORAL = '#FFE9E2';

export const colors = {
  // --- Canonical, semantic ---
  primary: PRIMARY,
  primaryDeep: PRIMARY_DEEP,
  accent: ACCENT,
  bg: BG,
  ink: INK,
  inkMuted: INK_MUTED,
  inkSubtle: INK_SUBTLE,

  /** Pill tinted surface for positive & neutral states. */
  tintTeal: TINT_TEAL,
  /** Pill tinted surface for attention/warning states. */
  tintCoral: TINT_CORAL,

  // Surfaces & lines
  surface: '#FFFFFF',
  border: BORDER,
  white: '#FFFFFF',
  /**
   * Transient pressed-state wash for rows and cards. A teal-leaning grey rather
   * than `tintTeal`, so a momentary press never reads as a status pill.
   */
  pressed: '#EDF2F1',

  // --- Semantic states ---
  // Mapped onto the two-tint system: anything positive/neutral reads teal,
  // anything needing attention reads coral. Deliberately NOT new raw hues —
  // the design language is two-colour on purpose.
  success: PRIMARY,
  alert: ACCENT,
  warning: ACCENT,

  /**
   * The two progress hues — and the ONE deliberate exception to the note above.
   *
   * Everywhere else in this app, teal-or-coral is the whole vocabulary, because
   * a status either means "act now" or it means "carry on". A progress display
   * is asking a different question: not "does this need me" but "how far along
   * is this", and the answer has three values, of which two are positive. Teal
   * for both "finished" and "happening right now" made a stage tracker where
   * every step past the first looked identical.
   *
   * Green is done, orange is in progress. They are used ONLY by progress and
   * stage-tracking displays — `StageProgress`, the status board, and the repeat
   * status pills — never for a call to action, which stays coral.
   */
  progressDone: '#158A4E',
  progressActive: '#C2670B',
  /** Pill washes for the two above, from the same family as `metricAccents`. */
  tintGreen: '#DCF0E3',
  tintOrange: '#FBEBD8',

  // --- Legacy aliases (re-themed in place; prefer the semantic names above) ---
  /** @deprecated use `colors.primary` */
  indigo: PRIMARY,
  /** @deprecated use `colors.ink` */
  indigoDeep: INK,
  /** @deprecated use `colors.accent` */
  brass: ACCENT,
  /** @deprecated use `colors.bg` */
  canvas: BG,
  /** @deprecated use `colors.inkMuted` */
  slate: INK_MUTED,

  // Damage accountability tag colors (consistent per party app-wide)
  accountVendor: INK_MUTED,
  accountWorker: ACCENT,
  accountPartner: PRIMARY,
} as const;

/**
 * Status pill treatment. Maps a semantic colour onto the tinted-pill pattern:
 * a light wash background with the full-strength colour as ink, rather than a
 * solid fill. Returns both halves so callers cannot pair them wrongly.
 */
export function pillTint(color: string): { bg: string; ink: string } {
  // Coral family — attention, warning, damage, breach.
  if (color === colors.accent) return { bg: TINT_CORAL, ink: ACCENT };
  // The two progress hues. Both inks clear 4.5:1 on their own wash, so a pill
  // reading "In Clipping" in orange is as legible as one reading "Passed" in
  // green — which matters more here than anywhere, because these two are the
  // pair a reader is actually comparing.
  if (color === colors.progressDone) return { bg: '#DCF0E3', ink: '#158A4E' };
  if (color === colors.progressActive) return { bg: '#FBEBD8', ink: '#C2670B' };
  // Muted/neutral gets a teal-leaning grey wash so it still sits in the system.
  if (color === colors.inkMuted || color === colors.inkSubtle) {
    return { bg: '#EDF2F1', ink: INK_MUTED };
  }
  // Everything else (teal family: primary, success, in-progress) reads teal.
  return { bg: TINT_TEAL, ink: PRIMARY };
}

/**
 * Metric-card accents — the ONE place this app is not two-colour.
 *
 * Everything else is deliberately teal-or-coral (see the palette notes above):
 * on a factory floor, a status that means "act now" has to be told from one
 * that means "carry on", and two hues do that better than six.
 *
 * A row of four summary cards is a different problem. There the colour is not
 * carrying a status at all — it is telling four cards apart so the eye can
 * return to the right one. Four accents, defined once, used only by
 * `MetricCard`; each is a `tint` for the icon well, an `ink` for the icon,
 * figure and sparkline, and a `card` wash for the card itself.
 */
export const metricAccents = {
  teal:  { tint: '#DCEFEE', ink: '#0D7377', card: '#F7FBFB' },
  green: { tint: '#DCF0E3', ink: '#1E8E5A', card: '#F7FCF9' },
  amber: { tint: '#FBEBD8', ink: '#C2761B', card: '#FEFAF5' },
  rose:  { tint: '#FBE0DD', ink: '#C7453A', card: '#FEF8F7' },
} as const;

export type MetricAccent = keyof typeof metricAccents;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

/**
 * Type scale from the design system.
 */
export const fontSize = {
  caption: 12, // captions, metadata
  secondary: 14, // secondary text, form labels
  body: 16, // body, default control text
  title: 20, // screen titles
  hero: 28, // dashboard hero numbers
} as const;

export const fontFamily = {
  /**
   * Poppins — the display/heading face. Headings, card titles, emphasis text,
   * button labels: anything that should read as a title rather than prose.
   */
  display: 'Poppins_600SemiBold',
  displayBold: 'Poppins_700Bold',
  /**
   * Inter — the body/UI face. Applied app-wide via the root font rule in
   * App.tsx, so screens inherit it without each setting it themselves.
   */
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemibold: 'Inter_600SemiBold',
  /**
   * IBM Plex Mono — RESERVED for codes and reference numbers only: order codes,
   * repeat codes, job card codes, needle numbers, thread colour codes, PO
   * numbers, stitch counts. Never body copy. This is the typographic signal that
   * a value is an identifier rather than prose. Carried over unchanged.
   */
  mono: 'IBMPlexMono_400Regular',
  monoSemibold: 'IBMPlexMono_600SemiBold',
} as const;

export const fontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

/**
 * Elevation presets. Kept few and shallow on purpose — this is a working
 * document, not a consumer app, so depth is used to separate a surface from the
 * canvas, never for decoration.
 */
export const elevation = {
  none: {},
  /** Resting cards and rows. */
  sm: {
    shadowColor: '#0A2E2C',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  /** Raised: primary buttons, sheets, anything that invites a press. */
  md: {
    shadowColor: '#0A2E2C',
    shadowOpacity: 0.09,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  /** Modals and popovers. */
  lg: {
    shadowColor: '#0A2E2C',
    shadowOpacity: 0.16,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
} as const;

/**
 * Soft tints derived from the palette, for pill backgrounds and icon wells.
 * An 8-digit hex is an alpha suffix, which react-native(-web) both accept.
 */
export function tint(hex: string, alpha = 0.12): string {
  const a = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}

/** Letter-spacing scale — small caps labels read better with a little air. */
export const tracking = {
  tight: -0.2,
  normal: 0,
  wide: 0.4,
  caps: 0.8,
} as const;

export const theme = {
  colors,
  metricAccents,
  spacing,
  radius,
  fontSize,
  fontFamily,
  fontWeight,
  elevation,
  tracking,
};
export type Theme = typeof theme;
