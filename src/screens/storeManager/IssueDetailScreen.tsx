/**
 * Issue Detail — the thread required for a confirmed job card, checked against
 * what's actually on the shelf, then issued to the floor manager.
 *
 * The requirement comes from the same calculation the order's submit-time
 * inventory check used, so what is issued matches what was checked. Issuing
 * writes one `issue` movement per colour, each referencing the material issue,
 * which references the job card — that chain is what makes consumption traceable
 * back to a specific order in Phase 7's leakage report.
 */
import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { StitchLine } from '../../components/ui/StitchLine';
import { StatusPill } from '../../components/ui/StatusPill';
import { getJobCardRequirements, issueMaterials } from '../../api/endpoints/inventory';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Alert } = require('react-native');
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm', onPress: onConfirm },
  ]);
}

export function IssueDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const jobCardId: string = route.params?.jobCardId;
  const orderCode: string | undefined = route.params?.orderCode;

  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ issue_code: string; total_meters: number } | null>(null);

  const { data: reqs, isLoading } = useQuery({
    queryKey: ['jobCardRequirements', jobCardId],
    queryFn: () => getJobCardRequirements(jobCardId),
  });

  const issueMutation = useMutation({
    mutationFn: () => issueMaterials(jobCardId, note.trim() || null),
    onSuccess: (r) => {
      setResult(r);
      for (const k of ['issueQueue', 'materialIssues', 'threadStock', 'stockLedger']) {
        queryClient.invalidateQueries({ queryKey: [k] });
      }
      // Refetch this screen's own table too, so the "In stock" column reflects
      // the deduction rather than the figures from before the issue.
      queryClient.invalidateQueries({ queryKey: ['jobCardRequirements', jobCardId] });
    },
    onError: (e) => setError(describeDbError(e, 'Material issue')),
  });

  if (isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const rows = reqs ?? [];
  const total = rows.reduce((n, r) => n + Number(r.required_meters), 0);
  const anyShort = rows.some((r) => !r.sufficient);

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.code}>{orderCode ?? 'Job card'}</Text>
        <Text style={styles.meta}>
          {rows.length} colour{rows.length === 1 ? '' : 's'} ·{' '}
          <Text style={styles.mono}>{total.toLocaleString()}</Text> m required
        </Text>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {result ? (
          <ActionBanner
            tone="neutral"
            title={`Materials issued · ${result.issue_code}`}
            subtitle={`${Number(result.total_meters).toLocaleString()} m deducted from stock, with an issue movement logged per colour against this job card.`}
            style={styles.bannerGap}
          />
        ) : null}

        <Text style={styles.sectionTitle}>Thread required</Text>

        <View style={styles.table}>
          <View style={styles.tableHeadRow}>
            <Text style={[styles.th, styles.colColor]}>Colour</Text>
            <Text style={[styles.th, styles.colNum]}>Required</Text>
            <Text style={[styles.th, styles.colNum]}>In stock</Text>
          </View>
          {rows.map((r) => (
            <View key={r.color_code} style={styles.tableRow}>
              <View style={[styles.colColor, { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }]}>
                <Text style={[styles.td, styles.mono]}>{r.color_code}</Text>
                {!r.sufficient ? <StatusPill label="Short" color={colors.alert} /> : null}
              </View>
              <Text style={[styles.td, styles.mono, styles.colNum]}>
                {Number(r.required_meters).toLocaleString()}
              </Text>
              <Text
                style={[
                  styles.td,
                  styles.mono,
                  styles.colNum,
                  !r.sufficient && { color: colors.alert },
                ]}
              >
                {Number(r.available_meters).toLocaleString()}
              </Text>
            </View>
          ))}
        </View>

        {anyShort ? (
          <ActionBanner
            title="Not enough stock"
            subtitle="At least one colour is short. Issuing will be refused — receive the outstanding purchase order first, or recount if the shelf disagrees."
            style={styles.bannerGap}
          />
        ) : null}

        {!result ? (
          <>
            <TextField
              label="Note"
              value={note}
              onChangeText={setNote}
              placeholder="e.g. Issued to floor manager, 2 trolleys"
              multiline
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <AppButton
              title="Issue to floor manager"
              onPress={() =>
                confirmAction(
                  'Issue materials',
                  `${total.toLocaleString()} m across ${rows.length} colour(s) will be deducted from stock and logged against this job card.`,
                  () => {
                    setError(null);
                    issueMutation.mutate();
                  }
                )
              }
              loading={issueMutation.isPending}
              disabled={anyShort}
            />
          </>
        ) : (
          <AppButton
            title="Back to queue"
            variant="secondary"
            onPress={() => navigation.navigate('MaterialIssueQueue')}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerGap: { marginBottom: spacing.lg },
  content: { padding: spacing.xl },
  code: { fontFamily: fontFamily.mono, fontSize: fontSize.title, color: colors.indigoDeep, fontWeight: fontWeight.semibold },
  meta: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  stitch: { marginVertical: spacing.lg },
  sectionTitle: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    marginBottom: spacing.lg,
  },
  tableHeadRow: { flexDirection: 'row', backgroundColor: colors.indigo, paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  th: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.semibold },
  tableRow: { flexDirection: 'row', paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, alignItems: 'center' },
  td: { fontSize: fontSize.secondary, color: colors.indigoDeep },
  colColor: { flex: 1 },
  colNum: { width: 90, textAlign: 'right' },
  mono: { fontFamily: fontFamily.mono },
  error: { color: colors.alert, fontSize: fontSize.secondary, marginBottom: spacing.sm },
  banner: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginBottom: spacing.lg },
});
