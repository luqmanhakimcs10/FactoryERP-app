/**
 * The stack of "you have work to do" banners at the very top of a dashboard.
 *
 * WHY THIS EXISTS
 * Most roles here are used by people on a factory floor, not by office staff
 * who will happily go exploring a menu. Burying "3 orders need a job card"
 * behind a section they have to know to open is a real barrier for that
 * audience. The notification bell already counted this work, but a badge is
 * passive — you have to look for it. This makes the same counts unmissable and
 * one tap from the actual task.
 *
 * ONE BANNER PER TASK TYPE, NOT ONE COMBINED
 * A Floor Manager can simultaneously have orders needing a job card, material
 * waiting to be accepted, and pieces to collect. Merging those into "6 things
 * need attention" would be worse than no banner: the user still has to go and
 * find out what the six are. Each keeps its own count, verb and destination.
 *
 * Renders nothing at all when there is no pending work — no empty state, no
 * "you're all caught up" card. A dashboard with nothing waiting should just be
 * the dashboard.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { ActionBanner } from './ActionBanner';
import { getQueueSummary } from '../../api/endpoints/stageHandover';
import { routeForBanner } from '../../navigation/taskQueues';
import { useAuth } from '../../auth/AuthContext';
import { spacing } from '../../constants/theme';

export function TaskBanners() {
  const navigation = useNavigation<any>();
  const { profile } = useAuth();

  const { data } = useQuery({
    // Same key the bell uses, so acting on a task refreshes both at once.
    queryKey: ['queueSummary', profile?.id ?? 'anon'],
    queryFn: getQueueSummary,
    enabled: !!profile?.id,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  // `own_task` filters out the owner's oversight rows: company_admin counts
  // every role's queue for the bell, but only their approvals are theirs to
  // act on. Without this the owner opens the app to nine stacked banners.
  const rows = (data ?? []).filter((r) => r.own_task && Number(r.count) > 0);
  if (rows.length === 0) return null;

  return (
    <View style={styles.stack}>
      {rows.map((r) => (
        <ActionBanner
          key={r.queue_key}
          title={r.banner_title}
          subtitle={r.banner_subtitle}
          onPress={() => {
            const route = routeForBanner(r.queue_key);
            navigation.navigate(route.screen as never, route.params as never);
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md, marginBottom: spacing.lg },
});

export default TaskBanners;
