/**
 * Add stock by hand — thread, tilla, sequin or bobbin.
 *
 * The form changes shape with the type because the four things genuinely differ:
 * bobbin is a length, sequin needs a size and can be entered as CD rolls, thread
 * and tilla are plain counts. Showing every field for every type and leaving the
 * user to work out which apply would be the same screen with the thinking left
 * undone.
 *
 * SEQUIN CD MATHS
 * ---------------
 * The count shown while typing comes from `previewSequinCount`, which mirrors
 * the database's `sequin_count_from_cds`. Only the CD COUNT is submitted — never
 * the previewed number — so the stored figure is always the database's own. The
 * preview exists so the store manager can sanity-check the result before saving,
 * which is the entire point of computing it rather than asking them to guess.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { describeDbError } from '../../utils/errors';
import {
  addInventory,
  previewSequinCount,
  ITEM_TYPES,
  ITEM_TYPE_LABEL,
  type ItemType,
} from '../../api/endpoints/storeManager';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

const SIZES = [3, 5, 9] as const;

/** What the quantity box means for each type, in the user's words. */
const QTY_LABEL: Record<ItemType, string> = {
  thread: 'Cones',
  tilla: 'Pieces',
  sequin: 'Sequins',
  bobbin: 'Length in metres',
};

export function AddInventoryScreen() {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();

  const [itemType, setItemType] = useState<ItemType>('thread');
  const [colorCode, setColorCode] = useState('');
  const [colorName, setColorName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [sizeMm, setSizeMm] = useState<number>(3);
  const [sequinType, setSequinType] = useState('');
  // Sequin entry mode: a direct count, or CD rolls the database converts.
  const [byCd, setByCd] = useState(true);
  const [cdCount, setCdCount] = useState('');
  const [yardsPerCd, setYardsPerCd] = useState('90');

  const preview = useMemo(() => {
    if (itemType !== 'sequin' || !byCd) return null;
    return previewSequinCount(Number(cdCount) || 0, sizeMm, Number(yardsPerCd) || 90);
  }, [itemType, byCd, cdCount, sizeMm, yardsPerCd]);

  const save = useMutation({
    mutationFn: () =>
      addInventory({
        itemType,
        colorCode: colorCode.trim(),
        colorName: colorName.trim() || null,
        quantity: itemType === 'sequin' && byCd ? null : Number(quantity),
        sizeMm: itemType === 'sequin' ? sizeMm : null,
        sequinType: itemType === 'sequin' ? sequinType.trim() || null : null,
        cdCount: itemType === 'sequin' && byCd ? Number(cdCount) : null,
        yardsPerCd: itemType === 'sequin' && byCd ? Number(yardsPerCd) || 90 : null,
      }),
    onSuccess: (item) => {
      // Prefix-invalidate: the inventory list, the audit walk and the task
      // banners all read stock, and a stale one of them would contradict the
      // other two.
      qc.invalidateQueries({ queryKey: ['inventoryItems'] });
      qc.invalidateQueries({ queryKey: ['threadStock'] });
      qc.invalidateQueries({ queryKey: ['auditWalk'] });
      qc.invalidateQueries({ queryKey: ['queueSummary'] });
      Alert.alert(
        'Stock added',
        `${item.color_code} is now ${Number(item.quantity).toLocaleString()} ${item.unit}.`
      );
      navigation.goBack();
    },
    onError: (e) => Alert.alert('Could not add stock', describeDbError(e, 'Inventory')),
  });

  const amountEntered =
    itemType === 'sequin' && byCd ? Number(cdCount) > 0 : Number(quantity) > 0;
  const canSave = colorCode.trim().length > 0 && amountEntered && !save.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Type</Text>
        <SegmentedTabs
          tabs={ITEM_TYPES.map((t) => ({ key: t, label: ITEM_TYPE_LABEL[t] }))}
          value={itemType}
          onChange={(t) => setItemType(t as ItemType)}
        />

        <Field label="Colour code" hint="How this colour is written on the shelf">
          <TextInput
            style={styles.input}
            value={colorCode}
            onChangeText={setColorCode}
            placeholder="RED-01"
            autoCapitalize="characters"
            placeholderTextColor={colors.inkSubtle}
          />
        </Field>

        <Field label="Colour name" hint="Optional — a readable name">
          <TextInput
            style={styles.input}
            value={colorName}
            onChangeText={setColorName}
            placeholder="Crimson"
            placeholderTextColor={colors.inkSubtle}
          />
        </Field>

        {itemType === 'sequin' ? (
          <>
            <Field label="Size" hint="Sequin diameter">
              <View style={styles.chips}>
                {SIZES.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setSizeMm(s)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: sizeMm === s }}
                    style={[styles.chip, sizeMm === s && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, sizeMm === s && styles.chipTextOn]}>
                      {s} mm
                    </Text>
                  </Pressable>
                ))}
              </View>
            </Field>

            <Field label="Sequin type" hint="Optional — finish or shape">
              <TextInput
                style={styles.input}
                value={sequinType}
                onChangeText={setSequinType}
                placeholder="Matt"
                placeholderTextColor={colors.inkSubtle}
              />
            </Field>

            <Field label="Enter as" hint="CD rolls are converted to a real count">
              <View style={styles.chips}>
                <Pressable
                  onPress={() => setByCd(true)}
                  style={[styles.chip, byCd && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: byCd }}
                >
                  <Text style={[styles.chipText, byCd && styles.chipTextOn]}>CD rolls</Text>
                </Pressable>
                <Pressable
                  onPress={() => setByCd(false)}
                  style={[styles.chip, !byCd && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !byCd }}
                >
                  <Text style={[styles.chipText, !byCd && styles.chipTextOn]}>Direct count</Text>
                </Pressable>
              </View>
            </Field>
          </>
        ) : null}

        {itemType === 'sequin' && byCd ? (
          <>
            <Field label="Number of CDs">
              <TextInput
                style={styles.input}
                value={cdCount}
                onChangeText={setCdCount}
                keyboardType="decimal-pad"
                placeholder="6"
                placeholderTextColor={colors.inkSubtle}
              />
            </Field>

            <Field label="Yards per CD" hint="Default 90 — change only if this roll differs">
              <TextInput
                style={styles.input}
                value={yardsPerCd}
                onChangeText={setYardsPerCd}
                keyboardType="decimal-pad"
                placeholderTextColor={colors.inkSubtle}
              />
            </Field>

            <View style={styles.previewBox}>
              <Text style={styles.previewLabel}>That works out as</Text>
              <Text style={styles.previewValue}>
                {preview != null ? `${preview.toLocaleString()} sequins` : '—'}
              </Text>
              <Text style={styles.previewHint}>
                ({yardsPerCd || 90} yards x 914 ÷ {sizeMm} mm) x 0.8, per CD
              </Text>
            </View>
          </>
        ) : (
          <Field
            label={QTY_LABEL[itemType]}
            hint={
              itemType === 'bobbin'
                ? 'Bobbins are counted by thread length remaining, not by how many there are'
                : undefined
            }
          >
            <TextInput
              style={styles.input}
              value={quantity}
              onChangeText={setQuantity}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={colors.inkSubtle}
            />
          </Field>
        )}

        <AppButton
          title="Add to stock"
          onPress={() => save.mutate()}
          disabled={!canSave}
          loading={save.isPending}
          style={{ marginTop: spacing.lg }}
        />
        <Text style={styles.footNote}>
          Added by hand, so this will show a Manual badge in the inventory list.
        </Text>
      </ScrollView>
    </Screen>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  field: { gap: spacing.xs },
  label: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  hint: { fontSize: fontSize.caption, color: colors.inkSubtle },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSize.body,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  chips: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill ?? 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: fontSize.secondary, color: colors.ink },
  chipTextOn: { color: colors.white, fontWeight: fontWeight.medium },
  previewBox: {
    backgroundColor: colors.tintTeal,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 2,
  },
  previewLabel: {
    fontSize: fontSize.caption,
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  previewValue: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.title,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  previewHint: { fontSize: fontSize.caption, color: colors.primary },
  footNote: { fontSize: fontSize.caption, color: colors.inkSubtle, textAlign: 'center' },
});
