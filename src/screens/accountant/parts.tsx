/**
 * Shared pieces for the accountant's six boxes.
 *
 * These exist so the five detail screens present money the same way: mono
 * figures, bordered flat rows on the canvas, labelled status pills, and one
 * definition of "pending / paid / unpaid". Copying the styles into each screen
 * is how they'd drift.
 */
import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { StatusPill } from '../../components/ui/StatusPill';
import { getPhotoUrl } from '../../api/endpoints/storage';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

/** Money is always mono, always 2dp — codes and amounts share one voice. */
export function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function count(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString();
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** One tile in a summary panel. `mono` for figures, plain for words. */
export function Tile({
  label,
  value,
  mono = true,
  tone,
  wide,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: string;
  wide?: boolean;
}) {
  return (
    <View style={[styles.tile, wide && styles.tileWide]}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text
        style={[
          styles.tileValue,
          mono && { fontFamily: fontFamily.mono },
          tone ? { color: tone } : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

export function TileGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

/** The bordered flat row used for transaction / PO / bill lists. */
export function FlatRow({
  code,
  mono = true,
  pill,
  lines,
  right,
  onPress,
}: {
  code: string;
  mono?: boolean;
  pill?: { label: string; color: string };
  lines?: (string | null | undefined)[];
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <>
      <View style={styles.rowTop}>
        <Text style={[styles.rowCode, mono && { fontFamily: fontFamily.mono }]} numberOfLines={1}>
          {code}
        </Text>
        {pill ? <StatusPill label={pill.label} color={pill.color} /> : null}
      </View>
      {(lines ?? [])
        .filter((l): l is string => !!l)
        .map((line, i) => (
          <Text key={i} style={styles.rowMeta}>
            {line}
          </Text>
        ))}
      {right}
    </>
  );

  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {body}
    </Pressable>
  );
}

/**
 * Invoice status as the accountant reads it: paid, unpaid (past its due date),
 * or pending. One definition, used by both the client detail and the receivable
 * list, so the same invoice can't be "pending" on one screen and "unpaid" on
 * the other.
 */
export function invoicePill(status: string, isOverdue: boolean): { label: string; color: string } {
  if (status === 'paid') return { label: 'Paid', color: colors.success };
  if (isOverdue) return { label: 'Unpaid', color: colors.alert };
  return { label: 'Pending', color: colors.warning };
}

export function expensePill(status: string): { label: string; color: string } {
  if (status === 'approved') return { label: 'Approved', color: colors.success };
  if (status === 'rejected') return { label: 'Rejected', color: colors.alert };
  return { label: 'Pending', color: colors.warning };
}

/**
 * A stored proof photo. Paths are private-bucket keys, so the URL is signed on
 * demand. "No photo" is shown in alert colour: from 0031 that state can only
 * exist on a record written before the photo rule, and it should look wrong.
 */
export function ProofThumb({ path, label = 'Photo' }: { path: string | null; label?: string }) {
  const { data: url } = useQuery({
    queryKey: ['photoUrl', path],
    queryFn: () => getPhotoUrl(path as string),
    enabled: !!path,
    staleTime: 45 * 60 * 1000,
  });

  if (!path) {
    return <Text style={styles.noPhoto}>No photo on file (recorded before proof was required)</Text>;
  }
  return (
    <View style={styles.proofWrap}>
      {url ? (
        <Image source={{ uri: url }} style={styles.proof} accessibilityLabel={label} />
      ) : (
        <View style={[styles.proof, styles.proofLoading]} />
      )}
      <Text style={styles.proofLabel}>{label}</Text>
    </View>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <Text style={styles.empty}>{children}</Text>;
}

export const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  tile: {
    flexBasis: '48%',
    flexGrow: 1,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tileWide: { flexBasis: '100%' },
  tileLabel: { fontSize: fontSize.caption, color: colors.slate, marginBottom: spacing.xs },
  tileValue: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowPressed: { backgroundColor: colors.pressed },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  rowCode: {
    flexShrink: 1,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    color: colors.indigoDeep,
  },
  rowMeta: { fontSize: fontSize.caption, color: colors.slate },
  mono: { fontFamily: fontFamily.mono, color: colors.indigoDeep },
  proofWrap: { marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  proof: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.canvas,
  },
  proofLoading: { opacity: 0.5 },
  proofLabel: { fontSize: fontSize.caption, color: colors.slate },
  noPhoto: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.alert },
  empty: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.slate,
  },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  subtitle: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  error: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.alert,
  },
  disabled: {
    padding: spacing.xl,
    fontSize: fontSize.body,
    color: colors.slate,
    textAlign: 'center',
  },
});
