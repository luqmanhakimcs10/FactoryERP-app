/**
 * Initial QA Dashboard — two boxes.
 *
 * "Awaiting order inspection" is the entry point for cloth inspection and
 * repeat coding (InspectionQueueScreen). "Repeats & stage tracking" is the
 * second entry point (Stage 9) — without it, QA has no route to any order
 * once it moves past coding into production, and therefore no way to reach
 * the Pass QA / Mark damage actions the spec requires QA to own.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { ActionBanner } from '../../components/ui/ActionBanner';
import { MasterCard, CardGrid, type MasterCardProps } from '../../components/ui/MasterCard';
import { listOrders } from '../../api/endpoints/orders';
import { listQaFinalQueue } from '../../api/endpoints/stageHandover';
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
  const { data: finalQueue } = useQuery({
    queryKey: ['qaFinalQueue'],
    queryFn: listQaFinalQueue,
  });

  const cards: (MasterCardProps & { key: string })[] = [
    {
      key: 'inspection',
      label: 'Awaiting order inspection',
      subtitle: 'Orders waiting on cloth inspection or repeat coding',
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
    // The second of the two final gates. Without a route here, a repeat the
    // Floor Manager has signed off would sit at awaiting_qa_final forever and
    // its order could never be invoiced.
    {
      key: 'finalPass',
      label: 'Final pass',
      subtitle: 'Cleared by the Floor Manager — the pass that completes a piece',
      icon: 'checkmark-done-outline',
      accent: colors.accent,
      count: finalQueue?.length ?? null,
      onPress: () => navigation.navigate('FinalPassQueue'),
    },
  ];

  const visible = useMemo(
    () => cards.filter((c) => matchesSearch(search, c.label, c.subtitle)),
    [search, data, inProduction, finalQueue]
  );

  // Inspection is the more urgent queue: an uninspected order blocks everything
  // downstream, whereas a final pass only holds up invoicing.
  const waiting = data?.length ?? 0;
  const finals = finalQueue?.length ?? 0;
  const banner =
    waiting > 0
      ? {
          title: `${waiting} order${waiting === 1 ? '' : 's'} awaiting inspection`,
          subtitle: 'Cloth inspection or repeat coding has not started',
          onPress: () => navigation.navigate('InspectionQueue'),
        }
      : finals > 0
        ? {
            title: `${finals} piece${finals === 1 ? '' : 's'} waiting on your final pass`,
            subtitle: 'Cleared by the Floor Manager — these complete the order',
            onPress: () => navigation.navigate('FinalPassQueue'),
          }
        : null;

  return (
    <Screen padded={false}>
      <DashboardHeader
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search sections"
        navigation={navigation}
      />
      <ScrollView contentContainerStyle={styles.container}>
        {banner ? <ActionBanner {...banner} style={styles.banner} /> : null}
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
