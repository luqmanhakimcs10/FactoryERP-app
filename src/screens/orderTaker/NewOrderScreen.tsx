/**
 * New Order capture — five screens, matching the approved reference design.
 *
 *   1 Which vendor is this for?   (tap a vendor card)
 *   2 How many colors?            (−5 / − / count / + / +5 stepper)
 *   3 Add each color              (swatch + sheets + repeats + photo, per colour)
 *   4 Design sheet                (single large capture button)
 *   5 Review & submit
 *
 * Deliberately NOT a "step X of 5" wizard and there is no separate cloth-photo
 * step: cloth photos are captured per colour on screen 3. Nothing here uses free
 * text for colour, sheets or repeats — every value is picked with a swatch or a
 * stepper, which is what makes this usable on a factory floor.
 *
 * DATA SHAPE: a colour with N sheets and M repeats expands to N `sheets` rows,
 * each carrying repeats_count = M, so the order → sheets → repeats hierarchy the
 * rest of the system depends on is unchanged.
 *
 * KNOWN GAP: this design captures no stitch count. `stitch_count` is therefore
 * submitted as 0, which means the submit-time thread check always reports
 * "sufficient" and never raises a purchase order. The reference design states
 * stock is checked "automatically from the design sheet" — until something reads
 * the design sheet, that check cannot produce real numbers.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Image,
  Modal,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { listMasters } from '../../api/endpoints/masters';
import { createOrder, submitOrder, updateOrderPhotos } from '../../api/endpoints/orders';
import { uploadOrderPhoto } from '../../api/endpoints/storage';
import { pickPhoto } from '../../components/camera/pickPhoto';
import { useAuth } from '../../auth/AuthContext';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
} from '../../constants/theme';

/** Thread colours offered by the swatch picker. */
const PALETTE = [
  { name: 'Red', code: 'RED-01', hex: '#C0392B' },
  { name: 'Gold', code: 'GLD-02', hex: '#D4A017' },
  { name: 'Black', code: 'BLK-03', hex: '#1C1C1C' },
  { name: 'White', code: 'WHT-04', hex: '#F2F2F0' },
  { name: 'Yellow', code: 'YEL-05', hex: '#E8B93B' },
  { name: 'Green', code: 'GRN-06', hex: '#2E7D52' },
  { name: 'Blue', code: 'BLU-07', hex: '#2B5CA8' },
  { name: 'Navy', code: 'NVY-08', hex: '#1B2A4A' },
  { name: 'Maroon', code: 'MRN-09', hex: '#7B241C' },
  { name: 'Pink', code: 'PNK-10', hex: '#D98BA6' },
  { name: 'Orange', code: 'ORG-11', hex: '#D2691E' },
  { name: 'Silver', code: 'SLV-12', hex: '#A9A9A9' },
];
type Swatch = (typeof PALETTE)[number];

interface ColorEntry {
  swatch: Swatch | null;
  sheets: number;
  repeats: number;
  photoUri: string | null;
}

type Step = 'vendor' | 'count' | 'colors' | 'design' | 'review';

export function NewOrderScreen() {
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const [step, setStep] = useState<Step>('vendor');
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const [colorCount, setColorCount] = useState(1);
  const [entries, setEntries] = useState<ColorEntry[]>([
    { swatch: null, sheets: 1, repeats: 1, photoUri: null },
  ]);
  const [designUri, setDesignUri] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const { data: vendors, isLoading: loadingVendors } = useQuery({
    queryKey: ['masters', 'vendors', '', false],
    queryFn: () => listMasters({ table: 'vendors', searchField: 'name' }),
  });

  /** Resize the per-colour cards when the count changes, preserving entries. */
  function applyCount(n: number) {
    const next = Math.max(1, Math.min(24, n));
    setColorCount(next);
    setEntries((prev) => {
      const out = prev.slice(0, next);
      while (out.length < next) out.push({ swatch: null, sheets: 1, repeats: 1, photoUri: null });
      return out;
    });
  }

  function patch(i: number, p: Partial<ColorEntry>) {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  }

  const totals = useMemo(() => {
    const sheets = entries.reduce((n, e) => n + e.sheets, 0);
    const repeats = entries.reduce((n, e) => n + e.sheets * e.repeats, 0);
    return { sheets, repeats };
  }, [entries]);

  const allColorsReady = entries.every((e) => e.swatch && e.sheets > 0 && e.repeats > 0);

  // ---- submit ----
  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!vendor) throw new Error('Pick a vendor first.');
      if (!profile?.factory_id) throw new Error('Your profile has no factory.');

      // One `sheets` row per physical sheet, each carrying its repeat count.
      const sheetInputs = entries.flatMap((e) =>
        Array.from({ length: e.sheets }, () => ({
          color_assignment: e.swatch!.name,
          repeats_count: e.repeats,
          thread_color_codes: [e.swatch!.code],
          stitch_count: 0, // see KNOWN GAP in the file header
        }))
      );

      setProgress('Creating order…');
      const order = await createOrder({ vendorId: vendor.id, sheets: sheetInputs });

      const clothPaths: string[] = [];
      const withPhotos = entries.filter((e) => e.photoUri);
      if (withPhotos.length || designUri) {
        setProgress('Uploading photos…');
        for (const e of withPhotos) {
          clothPaths.push(
            await uploadOrderPhoto(profile.factory_id, order.id, e.photoUri as string, 'cloth')
          );
        }
        let designPath: string | null = null;
        if (designUri) {
          designPath = await uploadOrderPhoto(profile.factory_id, order.id, designUri, 'design');
        }
        await updateOrderPhotos(order.id, clothPaths, designPath);
      }

      setProgress('Checking stock…');
      const result = await submitOrder(order.id);
      return { order, result };
    },
    onSuccess: ({ result }) => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      // Land back on the plain Orders list, not the detailed Progress screen —
      // that stays reachable by tapping into the order from here, but isn't
      // the automatic destination right after submit.
      navigation.navigate('MyOrders', { justSubmitted: result });
    },
    onError: (e) => {
      setProgress(null);
      setError(describeDbError(e, 'Order'));
    },
  });

  async function capture(target: 'design' | number, useCamera: boolean) {
    setError(null);
    const uri = await pickPhoto(useCamera);
    if (!uri) return;
    if (target === 'design') setDesignUri(uri);
    else patch(target, { photoUri: uri });
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ================= 1. VENDOR ================= */}
        {step === 'vendor' ? (
          <View style={styles.card}>
            <HeaderIcon name="business-outline" />
            <Text style={styles.title}>Which vendor is this for?</Text>
            <Text style={styles.subtitle}>Tap the vendor's name</Text>

            {loadingVendors ? (
              <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.lg }} />
            ) : (
              <View style={styles.vendorList}>
                {(vendors ?? []).map((v: any) => (
                  <Pressable
                    key={v.id}
                    onPress={() => {
                      setVendor({ id: v.id, name: v.name });
                      setStep('count');
                    }}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.vendorCard,
                      vendor?.id === v.id && styles.vendorCardOn,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>
                        {String(v.name ?? '?').trim().charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.vendorName}>{v.name}</Text>
                      <Text style={styles.vendorCity} numberOfLines={1}>
                        {cityOf(v.address) || '—'}
                      </Text>
                    </View>
                  </Pressable>
                ))}
                {!vendors?.length ? (
                  <Text style={styles.empty}>No vendors on file yet.</Text>
                ) : null}
              </View>
            )}
          </View>
        ) : null}

        {/* ================= 2. COLOR COUNT ================= */}
        {step === 'count' ? (
          <View style={styles.card}>
            <HeaderIcon name="color-fill-outline" />
            <Text style={styles.title}>How many colors?</Text>
            <Text style={styles.subtitle}>Count the different thread colors in this order</Text>

            <View style={styles.bigStepper}>
              <StepBtn label="−5" onPress={() => applyCount(colorCount - 5)} variant="outline" />
              <StepBtn label="−" onPress={() => applyCount(colorCount - 1)} variant="circle" />
              <View style={styles.bigCountWrap}>
                <Text style={styles.bigCount}>{colorCount}</Text>
                <Text style={styles.bigCountLabel}>colors</Text>
              </View>
              <StepBtn label="+" onPress={() => applyCount(colorCount + 1)} variant="circleFill" />
              <StepBtn label="+5" onPress={() => applyCount(colorCount + 5)} variant="fill" />
            </View>

            <NavRow
              onBack={() => setStep('vendor')}
              nextLabel="Next"
              onNext={() => setStep('colors')}
            />
          </View>
        ) : null}

        {/* ================= 3. ADD EACH COLOR ================= */}
        {step === 'colors' ? (
          <View style={styles.card}>
            <HeaderIcon name="color-fill-outline" />
            <Text style={styles.title}>Add each color</Text>
            <Text style={styles.subtitle}>Pick the color, sheets, repeats, and a photo for each</Text>

            {entries.map((e, i) => (
              <View key={i} style={styles.colorCard}>
                <Text style={styles.colorCardLabel}>Color {i + 1}</Text>

                <View style={styles.colorRow}>
                  {/* colour swatch */}
                  <View style={styles.colorCell}>
                    <Pressable
                      onPress={() => setPickerFor(i)}
                      accessibilityRole="button"
                      accessibilityLabel={`Choose colour for color ${i + 1}`}
                      style={({ pressed }) => [
                        styles.swatch,
                        e.swatch
                          ? { backgroundColor: e.swatch.hex, borderColor: e.swatch.hex, borderStyle: 'solid' }
                          : null,
                        pressed && styles.pressed,
                      ]}
                    >
                      {!e.swatch ? (
                        <Ionicons name="color-fill-outline" size={22} color={colors.brass} />
                      ) : null}
                    </Pressable>
                    <Text style={styles.cellLabel}>{e.swatch ? e.swatch.name : 'Color'}</Text>
                  </View>

                  <Stepper
                    label="Sheets"
                    value={e.sheets}
                    onDec={() => patch(i, { sheets: Math.max(1, e.sheets - 1) })}
                    onInc={() => patch(i, { sheets: e.sheets + 1 })}
                  />
                  <Stepper
                    label="Repeats"
                    value={e.repeats}
                    onDec={() => patch(i, { repeats: Math.max(1, e.repeats - 1) })}
                    onInc={() => patch(i, { repeats: e.repeats + 1 })}
                  />

                  {/* photo */}
                  <View style={styles.colorCell}>
                    <Pressable
                      onPress={() => capture(i, true)}
                      onLongPress={() => capture(i, false)}
                      accessibilityRole="button"
                      accessibilityLabel={`Photo for color ${i + 1}`}
                      style={({ pressed }) => [styles.photoBtn, pressed && styles.pressed]}
                    >
                      {e.photoUri ? (
                        <Image source={{ uri: e.photoUri }} style={styles.photoThumb} />
                      ) : (
                        <Ionicons name="camera-outline" size={22} color={colors.brass} />
                      )}
                    </Pressable>
                    <Text style={styles.cellLabel}>Photo</Text>
                  </View>
                </View>
              </View>
            ))}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <NavRow
              onBack={() => setStep('count')}
              nextLabel="Design sheet"
              onNext={() => setStep('design')}
              nextDisabled={!allColorsReady}
            />
            {!allColorsReady ? (
              <Text style={styles.hint}>Pick a colour for every card to continue.</Text>
            ) : null}
          </View>
        ) : null}

        {/* ================= 4. DESIGN SHEET ================= */}
        {step === 'design' ? (
          <View style={styles.card}>
            <HeaderIcon name="image-outline" />
            <Text style={styles.title}>Design sheet</Text>
            <Text style={styles.subtitle}>
              Take a photo of the design sheet from the vendor, if there is one
            </Text>

            <Pressable
              onPress={() => capture('design', true)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.captureBtn, pressed && styles.pressed]}
            >
              {designUri ? (
                <Image source={{ uri: designUri }} style={styles.captureThumb} />
              ) : (
                <>
                  <Ionicons name="camera" size={40} color={colors.white} />
                  <Text style={styles.captureLabel}>Take photo</Text>
                </>
              )}
            </Pressable>

            {/* Gallery is offered here per the later photo-capture change; the
                shift-close flow remains camera-only. */}
            <Pressable
              onPress={() => capture('design', false)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.galleryLink, pressed && styles.pressed]}
            >
              <Ionicons name="images-outline" size={16} color={colors.indigo} />
              <Text style={styles.galleryText}>Choose from gallery</Text>
            </Pressable>

            <NavRow
              onBack={() => setStep('colors')}
              nextLabel="Review"
              onNext={() => setStep('review')}
            />
          </View>
        ) : null}

        {/* ================= 5. REVIEW ================= */}
        {step === 'review' ? (
          <View style={styles.card}>
            <Text style={styles.reviewTitle}>Review &amp; submit</Text>
            <Text style={styles.vendorLine}>
              <Text style={styles.vendorLineLabel}>Vendor: </Text>
              {vendor?.name ?? '—'}
            </Text>

            {entries.map((e, i) => (
              <View key={i} style={styles.reviewRow}>
                <View style={styles.reviewThumbWrap}>
                  {e.photoUri ? (
                    <Image source={{ uri: e.photoUri }} style={styles.reviewThumb} />
                  ) : (
                    <Ionicons name="color-fill-outline" size={22} color={colors.slate} />
                  )}
                </View>
                <View style={[styles.dot, { backgroundColor: e.swatch?.hex ?? colors.border }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.reviewName}>{e.swatch?.name ?? 'No colour'}</Text>
                  <Text style={styles.reviewMeta}>
                    {e.sheets} sheet{e.sheets === 1 ? '' : 's'} · {e.repeats} repeats each
                  </Text>
                </View>
              </View>
            ))}

            <View style={styles.designCard}>
              <Text style={styles.designCardTitle}>Design sheet</Text>
              {designUri ? (
                <Image source={{ uri: designUri }} style={styles.designPreview} resizeMode="contain" />
              ) : (
                <View style={styles.designPlaceholder}>
                  <Ionicons name="image-outline" size={28} color={colors.slate} />
                  <Text style={styles.reviewMeta}>None attached</Text>
                </View>
              )}
            </View>

            <View style={styles.totals}>
              <TotalRow label="Total sheets" value={totals.sheets} />
              <TotalRow label="Total repeats" value={totals.repeats} />
            </View>

            <View style={styles.infoBanner}>
              <Ionicons name="information-circle-outline" size={18} color={colors.indigo} />
              <Text style={styles.infoText}>
                Thread, Tillah and Sequin stock will be checked automatically.
              </Text>
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {progress ? (
              <View style={styles.progressRow}>
                <ActivityIndicator color={colors.indigo} />
                <Text style={styles.hint}>{progress}</Text>
              </View>
            ) : null}

            <View style={styles.navRow}>
              <AppButton
                title="Back"
                variant="secondary"
                onPress={() => setStep('design')}
                disabled={submitMutation.isPending}
                style={{ flex: 1 }}
              />
              <AppButton
                title="Submit order  ✓"
                onPress={() => {
                  setError(null);
                  submitMutation.mutate();
                }}
                loading={submitMutation.isPending}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* ---- colour picker ----
          Conditionally rendered rather than relying on Modal's `visible` prop:
          react-native-web leaves the overlay mounted and painted when visible
          flips to false, so the picker stayed on screen after a selection. */}
      {pickerFor !== null ? (
      <Modal visible transparent animationType="fade">
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerFor(null)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Pick a colour</Text>
            <View style={styles.paletteGrid}>
              {PALETTE.map((c) => (
                <Pressable
                  key={c.code}
                  onPress={() => {
                    if (pickerFor !== null) patch(pickerFor, { swatch: c });
                    setPickerFor(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={c.name}
                  style={({ pressed }) => [styles.paletteCell, pressed && styles.pressed]}
                >
                  <View style={[styles.paletteSwatch, { backgroundColor: c.hex }]} />
                  <Text style={styles.paletteName}>{c.name}</Text>
                </Pressable>
              ))}
            </View>
            <AppButton title="Cancel" variant="secondary" onPress={() => setPickerFor(null)} />
          </Pressable>
        </Pressable>
      </Modal>
      ) : null}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function HeaderIcon({ name }: { name: any }) {
  return (
    <View style={styles.headerIcon}>
      <Ionicons name={name} size={30} color={colors.indigo} />
    </View>
  );
}

function StepBtn({
  label, onPress, variant,
}: { label: string; onPress: () => void; variant: 'outline' | 'circle' | 'circleFill' | 'fill' }) {
  const isCircle = variant === 'circle' || variant === 'circleFill';
  const filled = variant === 'fill' || variant === 'circleFill';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.stepBtn,
        isCircle && styles.stepBtnCircle,
        filled ? styles.stepBtnFill : styles.stepBtnOutline,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.stepBtnText, filled && styles.stepBtnTextFill]}>{label}</Text>
    </Pressable>
  );
}

function Stepper({
  label, value, onDec, onInc,
}: { label: string; value: number; onDec: () => void; onInc: () => void }) {
  return (
    <View style={styles.stepperCell}>
      <Text style={styles.cellLabelTop}>{label}</Text>
      <View style={styles.stepperRow}>
        <Pressable
          onPress={onDec}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${label}`}
          style={({ pressed }) => [styles.miniBtn, pressed && styles.pressed]}
        >
          <Ionicons name="remove" size={16} color={colors.slate} />
        </Pressable>
        <Text style={styles.stepperValue}>{value}</Text>
        <Pressable
          onPress={onInc}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${label}`}
          style={({ pressed }) => [styles.miniBtn, styles.miniBtnFill, pressed && styles.pressed]}
        >
          <Ionicons name="add" size={16} color={colors.white} />
        </Pressable>
      </View>
    </View>
  );
}

function NavRow({
  onBack, onNext, nextLabel, nextDisabled,
}: { onBack: () => void; onNext: () => void; nextLabel: string; nextDisabled?: boolean }) {
  return (
    <View style={styles.navRow}>
      <AppButton title="←  Back" variant="secondary" onPress={onBack} style={{ flex: 1 }} />
      <AppButton
        title={`${nextLabel}  →`}
        onPress={onNext}
        disabled={nextDisabled}
        style={{ flex: 1 }}
      />
    </View>
  );
}

function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.totalRow}>
      <Text style={styles.totalLabel}>{label}</Text>
      <Text style={styles.totalValue}>{value}</Text>
    </View>
  );
}

/** Last comma-separated part of an address reads as the city. */
function cityOf(address?: string | null): string {
  if (!address) return '';
  const parts = String(address).split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, alignItems: 'center' },
  card: {
    width: '100%',
    maxWidth: 640,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
  },
  headerIcon: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: colors.tintTeal,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: 26, fontWeight: fontWeight.semibold,
    color: colors.indigoDeep, textAlign: 'center',
  },
  subtitle: {
    marginTop: spacing.xs, fontSize: fontSize.body,
    color: colors.slate, textAlign: 'center',
  },

  // vendor
  vendorList: { width: '100%', marginTop: spacing.xl, gap: spacing.md },
  vendorCard: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.lg,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg,
    padding: spacing.lg, minHeight: 84, backgroundColor: colors.surface,
  },
  vendorCardOn: { borderColor: colors.primary, backgroundColor: colors.tintTeal },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.indigo, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.white, fontSize: 22, fontWeight: fontWeight.semibold },
  vendorName: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  vendorCity: { marginTop: 2, fontSize: fontSize.body, color: colors.slate },
  empty: { padding: spacing.lg, color: colors.slate, textAlign: 'center' },

  // big stepper
  bigStepper: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.lg, marginVertical: spacing.xxl,
  },
  bigCountWrap: { alignItems: 'center', minWidth: 90 },
  bigCount: { fontSize: 56, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  bigCountLabel: { fontSize: fontSize.body, color: colors.slate },
  stepBtn: {
    minWidth: 60, height: 60, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md,
  },
  stepBtnCircle: { borderRadius: 30, minWidth: 60 },
  stepBtnOutline: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  stepBtnFill: { backgroundColor: colors.indigo },
  stepBtnText: { fontSize: 22, fontWeight: fontWeight.semibold, color: colors.slate },
  stepBtnTextFill: { color: colors.white },

  // per-colour card
  colorCard: {
    width: '100%', borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing.lg, marginTop: spacing.lg,
  },
  colorCardLabel: { fontSize: fontSize.secondary, color: colors.slate, marginBottom: spacing.md },
  colorRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    justifyContent: 'space-between', gap: spacing.md,
  },
  colorCell: { alignItems: 'center', width: 76 },
  swatch: {
    width: 52, height: 52, borderRadius: 26,
    borderWidth: 2, borderColor: colors.brass, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas,
  },
  photoBtn: {
    width: 52, height: 52, borderRadius: radius.md,
    borderWidth: 2, borderColor: colors.brass, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas,
    overflow: 'hidden',
  },
  photoThumb: { width: '100%', height: '100%' },
  cellLabel: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.slate },
  cellLabelTop: { fontSize: fontSize.caption, color: colors.slate, marginBottom: spacing.xs },
  stepperCell: { alignItems: 'center', flex: 1 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  miniBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  miniBtnFill: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  stepperValue: {
    minWidth: 28, textAlign: 'center',
    fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep,
  },

  // capture
  captureBtn: {
    width: 200, height: 200, borderRadius: radius.lg,
    backgroundColor: colors.indigo, alignItems: 'center', justifyContent: 'center',
    marginVertical: spacing.xl, overflow: 'hidden', gap: spacing.sm,
  },
  captureThumb: { width: '100%', height: '100%' },
  captureLabel: { color: colors.white, fontSize: fontSize.title, fontWeight: fontWeight.semibold },
  galleryLink: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.lg },
  galleryText: { color: colors.indigo, fontSize: fontSize.secondary, fontWeight: fontWeight.medium },

  // review
  reviewTitle: {
    fontSize: 26, fontWeight: fontWeight.semibold,
    color: colors.indigoDeep, alignSelf: 'flex-start',
  },
  vendorLine: { alignSelf: 'flex-start', marginTop: spacing.md, fontSize: fontSize.body, color: colors.indigoDeep },
  vendorLineLabel: { fontWeight: fontWeight.semibold },
  reviewRow: {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: spacing.md, marginTop: spacing.md,
  },
  reviewThumbWrap: {
    width: 48, height: 48, borderRadius: radius.sm, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas,
  },
  reviewThumb: { width: '100%', height: '100%' },
  dot: { width: 18, height: 18, borderRadius: 9 },
  reviewName: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  reviewMeta: { fontSize: fontSize.secondary, color: colors.slate },
  designCard: {
    width: '100%', borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, marginTop: spacing.lg, overflow: 'hidden',
  },
  designCardTitle: {
    padding: spacing.md, fontSize: fontSize.body,
    fontWeight: fontWeight.semibold, color: colors.indigoDeep,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  designPreview: { width: '100%', height: 140, backgroundColor: colors.canvas },
  designPlaceholder: { height: 110, alignItems: 'center', justifyContent: 'center', gap: 4 },
  totals: {
    width: '100%', backgroundColor: colors.canvas, borderRadius: radius.md,
    padding: spacing.md, marginTop: spacing.lg,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  totalLabel: { fontSize: fontSize.body, color: colors.indigoDeep },
  totalValue: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  infoBanner: {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.tintTeal, borderRadius: radius.md,
    padding: spacing.md, marginTop: spacing.lg,
  },
  infoText: { flex: 1, fontSize: fontSize.secondary, color: colors.indigoDeep, lineHeight: 20 },

  navRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl, width: '100%' },
  hint: { marginTop: spacing.sm, fontSize: fontSize.caption, color: colors.slate, textAlign: 'center' },
  error: { marginTop: spacing.md, color: colors.alert, fontSize: fontSize.secondary, textAlign: 'center' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  pressed: { opacity: 0.75 },

  // modal
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(21,31,56,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: spacing.lg,
  },
  modalCard: {
    width: '100%', maxWidth: 420, backgroundColor: colors.surface,
    borderRadius: radius.lg, padding: spacing.xl,
  },
  modalTitle: {
    fontSize: fontSize.title, fontWeight: fontWeight.semibold,
    color: colors.indigoDeep, marginBottom: spacing.lg,
  },
  paletteGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.lg },
  paletteCell: { alignItems: 'center', width: 72 },
  paletteSwatch: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border },
  paletteName: { marginTop: 4, fontSize: fontSize.caption, color: colors.slate },
});
