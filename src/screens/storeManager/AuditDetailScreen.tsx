/**
 * One past audit: system count vs actual count per item, and what was corrected.
 *
 * The figures are the ones stored at the time, not recomputed. Phase 4's schema
 * comment explains why the variance is a stored column: the expected figure is a
 * point-in-time snapshot, and what was signed off must stay what was signed off
 * even as stock moves on. Recomputing here would quietly rewrite history.
 */
import React from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { EmptyState, Loading } from '../../components/ui/States';
import { StatusPill } from '../../components/ui/StatusPill';
import { describeDbError } from '../../utils/errors';
import { getAuditDetail, ITEM_TYPE_LABEL } from '../../api/endpoints/storeManager';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

export function AuditDetailScreen() {
  const route = useRoute<any>();
  const auditId = route.params?.auditId as string;

  const q = useQuery({
    queryKey: ['auditDetail', auditId],
    queryFn: () => getAuditDetail(auditId),
    enabled: !!auditId,
  });

  const rows = q.data ?? [];
  const corrected = rows.filter((r) => Number(r.variance) !== 0).length;

  return (
    <Screen padded={false}>
      <FlatList
        data={rows}
        keyExtractor={(r, i) => `${r.color_code}-${i}`}
        initialNumToRender={30}
        removeClippedSubviews={false}
        ListHeaderComponent={
          <View style={styles.header}>
            {q.isLoading ? <Loading /> : null}
            {q.isError ? (
              <Text style={styles.error}>{describeDbError(q.error, 'Audit')}</Text>
            ) : null}
            {rows.length > 0 ? (
              <Text style={styles.summary}>
                {rows.length} item{rows.length === 1 ? '' : 's'} counted ·{' '}
                {corrected === 0 ? 'all correct' : `${corrected} corrected`}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !q.isLoading ? (
            <View style={{ padding: spacing.xl }}>
              <EmptyState
                icon="document-outline"
                title="Nothing recorded"
                message="This audit has no items against it."
              />
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const variance = Number(item.variance);
          return (
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.rowTop}>
                  <Text style={styles.code}>{item.color_code}</Text>
                  <StatusPill
                    label={variance === 0 ? 'Correct' : 'Corrected'}
                    color={variance === 0 ? colors.primary : colors.accent}
                  />
                </View>
                <Text style={styles.sub}>
                  {ITEM_TYPE_LABEL[item.item_type] ?? item.item_type}
                  {item.color_name ? ` · ${item.color_name}` : ''}
                </Text>
              </View>
              <View style={styles.figures}>
                <Text style={styles.figureLabel}>System</Text>
                <Text style={styles.figure}>
                  {Number(item.expected_quantity).toLocaleString()}
                </Text>
              </View>
              <View style={styles.figures}>
                <Text style={styles.figureLabel}>Actual</Text>
                <Text style={[styles.figure, variance !== 0 && { color: colors.accent }]}>
                  {Number(item.actual_quantity).toLocaleString()}
                </Text>
              </View>
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { padding: spacing.lg, gap: spacing.sm },
  summary: { fontSize: fontSize.secondary, color: colors.slate },
  error: { color: colors.alert, fontSize: fontSize.secondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    marginHorizontal: spacing.lg,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  sub: { fontSize: fontSize.caption, color: colors.slate },
  figures: { alignItems: 'flex-end', minWidth: 64 },
  figureLabel: { fontSize: fontSize.caption, color: colors.inkSubtle },
  figure: { fontFamily: fontFamily.mono, fontSize: fontSize.body, color: colors.ink },
});
