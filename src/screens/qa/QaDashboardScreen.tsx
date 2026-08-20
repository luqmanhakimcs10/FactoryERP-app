/**
 * QA Dashboard — two boxes.
 *
 * "Awaiting order inspection" is the ONE entry point into the inspection and
 * coding flow: cloth inspection and repeat coding are steps inside it, not
 * separate queues to choose between. "Repeats & stage tracking" is the second
 * box — without it, QA has no route to any order once it moves past coding into
 * production, and therefore no way to reach the Pass QA / Mark damage actions
 * the spec requires QA to own.
 *
 * FINAL QA IS NOT HERE. It was a third box, and the second of two final gates.
 * Final QA is the Floor Manager's step now and QA has no part in it — 0087
 * dropped `qa_final_pass` outright, so this is a removed capability rather than
 * a hidden card.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { MasterCard, CardGrid, type MasterCardProps } from '../../components/ui/MasterCard';
import { MetricCard, MetricRow, MetricsSection } from '../../components/ui/MetricCard';
import { statCount } from '../../utils/statValue';
import { listOrders, listFactoryDamage } from '../../api/endpoints/orders';
import { matchesSearch } from '../../utils/search';
import { colors, spacing, fontSize } from '../../constants/theme';

const QA_STATUSES = ['awaiting_cloth_inspection', 'awaiting_coding'];
const STAGE_TRACKING_STATUSES = ['in_production', 'in_finishing'];

export function QaDashboardScreen() {
  const navigation = useNavigation<any>();
  const [search, setSearch] = useState('');

  const { data } = useQuery({
    queryKey: ['orders', 'qaQueue'],
    queryFn: () => listOrders(QA_STATUSES),
  });
  const { data: inProduction } = useQuery({
    queryKey: ['orders', 'qaStageTracking'],
    queryFn: () => listOrders(STAGE_TRACKING_STATUSES),
  });
  /**
   * Three, not four. QA's work is two queues and the pieces bouncing between
   * them — inventing a fourth figure would mean showing a number this role does
   * not act on.
   *
   * The rejected count reads `damage_records` directly, which is the same table
   * the Repeat QA tab already renders from; `recheck_state` is what 0059 added
   * to track the reject/return loop.
   */
  const rejected = useQuery({
    queryKey: ['qaRejectedAwaitingReturn'],
    queryFn: async () => {
      const rows = await listFactoryDamage();
      return rows.filter(
        (d: any) =>
          d.stage_type === 'repeat_qa' &&
          d.repeat_id === null &&
          (d.recheck_state ?? 'awaiting_return') === 'awaiting_return'
      ).length;
    },
  });

  const cards: (MasterCardProps & { key: string })[] = [
    {
      key: 'inspection',
      label: 'Awaiting order inspection',
      subtitle: 'Check the cloth, then inspect every piece — one flow per order',
      icon: 'shield-checkmark-outline',
      accent: colors.accent,
      count: data?.length ?? null,
      onPress: () => navigation.navigate('InspectionQueue'),
    },
    {
      key: 'stageTracking',
      label: 'Repeats & stage tracking',
      subtitle: 'Pass QA and mark damage as repeats move through production',
      icon: 'layers-outline',
      accent: colors.primary,
      count: inProduction?.length ?? null,
      onPress: () => navigation.navigate('StageTrackingQueue'),
    },
  ];

  const visible = useMemo(
    () => cards.filter((c) => matchesSearch(search, c.label, c.subtitle)),
    [search, data, inProduction]
  );

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search sections"
        navigation={navigation}
      />
      <ScrollView contentContainerStyle={styles.container}>
        <TaskBanners />

        <MetricsSection subtitle="What is waiting on inspection">
          <MetricRow>
            <MetricCard
              label="Orders awaiting QA"
              value={statCount(data?.length)}
              icon="shield-checkmark-outline"
              accent={data?.length ? 'amber' : 'teal'}
              onPress={() => navigation.navigate('InspectionQueue')}
            />
            <MetricCard
              label="Orders in production"
              value={statCount(inProduction?.length)}
              icon="layers-outline"
              accent="green"
              onPress={() => navigation.navigate('StageTrackingQueue')}
            />
            <MetricCard
              label="Rejected, awaiting return"
              value={statCount(rejected.data)}
              icon="return-up-back-outline"
              accent={rejected.data ? 'rose' : 'teal'}
            />
          </MetricRow>
        </MetricsSection>
        <CardGrid>
          {visible.map(({ key, ...card }) => (
            <MasterCard key={key} {...card} />
          ))}
        </CardGrid>
        {visible.length === 0 ? (
          <Text style={styles.empty}>No sections match “{search}”.</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  metrics: { marginBottom: spacing.lg },
  container: { padding: spacing.lg, paddingTop: spacing.xl },
  banner: { marginBottom: spacing.lg },
  empty: {
    paddingTop: spacing.xl,
    color: colors.inkMuted,
    fontSize: fontSize.secondary,
    textAlign: 'center',
  },
});

export default QaDashboardScreen;
