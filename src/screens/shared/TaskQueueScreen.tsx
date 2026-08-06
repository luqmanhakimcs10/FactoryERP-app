/**
 * The filtered list behind one task banner.
 *
 * ONE screen for every queue, not ten. The rows all arrive in the same shape
 * from `my_queue_items` (0066), so the only thing that varies per queue is the
 * destination — which lives in `taskQueues.ts`, not here.
 *
 * The whole point is the second tap: a row goes STRAIGHT to the existing
 * working screen for that item. Not a summary, not a simplified stand-in — the
 * same screen the user would eventually reach by navigating, reached without
 * having to know which section it lives in.
 */
import React from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { EmptyState, ListSkeleton } from '../../components/ui/States';
import { getQueueItems, type QueueItem } from '../../api/endpoints/stageHandover';
import { QUEUE_SCREEN_TITLE, routeForItem } from '../../navigation/taskQueues';
import { describeDbError } from '../../utils/errors';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export function TaskQueueScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const queueKey: string = route.params?.queueKey;

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['queueItems', queueKey],
    queryFn: () => getQueueItems(queueKey),
    enabled: !!queueKey,
  });

  const heading = QUEUE_SCREEN_TITLE[queueKey] ?? 'Waiting on you';
  const rows = data ?? [];

  function open(item: QueueItem) {
    const target = routeForItem(queueKey, item);
    if (!target) return;
    navigation.navigate(target.screen, target.params);
  }

  if (isLoading) {
    return (
      <Screen padded={false}>
        <ListSkeleton rows={4} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <View style={styles.head}>
        <Text style={styles.title}>{heading}</Text>
        <Text style={styles.sub}>
          {rows.length} item{rows.length === 1 ? '' : 's'} · tap one to start
        </Text>
        <View style={styles.stitch} />
      </View>

      {isError ? (
        <Text style={styles.error}>{describeDbError(error, 'Queue')}</Text>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.item_id}
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        // Same react-native-web virtualisation trap as the other lists here:
        // windowing never advances, so only the first ~10 rows would render.
        initialNumToRender={rows.length || 20}
        windowSize={21}
        removeClippedSubviews={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.accent} />
        }
        ListEmptyComponent={
          <EmptyState
            icon="checkmark-done-outline"
            title="Nothing waiting here"
            message="This queue is clear. Anything new will appear on your dashboard."
          />
        }
        renderItem={({ item }) => {
          const tappable = routeForItem(queueKey, item) !== null;
          return (
            <Pressable
              accessibilityRole={tappable ? 'button' : undefined}
              accessibilityLabel={`${item.title ?? item.code}. ${item.subtitle ?? ''}`}
              disabled={!tappable}
              onPress={() => open(item)}
              style={({ pressed }) => [styles.row, pressed && tappable && styles.rowPressed]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.code}>{item.title ?? item.code}</Text>
                {item.subtitle ? <Text style={styles.meta}>{item.subtitle}</Text> : null}
              </View>
              {tappable ? (
                <Ionicons name="chevron-forward" size={18} color={colors.inkSubtle} />
              ) : null}
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.ink },
  sub: { marginTop: 2, fontSize: fontSize.secondary, color: colors.inkMuted },
  stitch: {
    marginTop: spacing.md,
    borderBottomWidth: 1,
    borderStyle: 'dashed',
    borderBottomColor: colors.accent,
    opacity: 0.5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.lg,
    minHeight: 72,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.pressed },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  meta: { fontSize: fontSize.caption, color: colors.inkMuted },
  error: { paddingHorizontal: spacing.lg, color: colors.accent, fontSize: fontSize.secondary },
});

export default TaskQueueScreen;
