/**
 * Machine & Workforce — Floor Manager (Stage 6).
 *
 * Replaces the dashboard's separate Machine and Shift cards with one tabbed
 * screen: "Machines" (unchanged assignment/registry links) and "Shifts" (new
 * Shift Calendar — a date stepper + per-machine open/closed state for that
 * date, with "Start shift" as the entry point into the existing OpenShift
 * flow). No native date-picker dependency: a day stepper is enough for a
 * factory-floor calendar and avoids adding a package this repo has no other
 * use for.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { ListRow } from '../../components/lists/ListRow';
import { listShiftsForDate } from '../../api/endpoints/shifts';
import { describeDbError } from '../../utils/errors';
import type { ShiftForDateRow } from '../../models/shiftTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

type TabKey = 'machines' | 'shifts';

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  closed: 'Closed',
  flagged_idle: 'Flagged idle',
};
const STATUS_COLOR: Record<string, string> = {
  open: colors.primary,
  closed: colors.success,
  flagged_idle: colors.warning,
};

export function MachineWorkforceScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const [tab, setTab] = useState<TabKey>(route.params?.tab === 'shifts' ? 'shifts' : 'machines');
  const [date, setDate] = useState(() => new Date());

  return (
    <Screen padded={false}>
      <SegmentedTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'machines', label: 'Machines' },
          { key: 'shifts', label: 'Shifts' },
        ]}
      />

      {tab === 'machines' ? (
        <View style={styles.rows}>
          <ListRow
            title="Assign & open shift"
            subtitle="Pick a machine, assign a worker and order, capture the open panel photo"
            onPress={() => navigation.navigate('MachineList')}
          />
          <ListRow
            title="Machine registry"
            subtitle="Add, edit and retire machines"
            onPress={() => navigation.navigate('MasterList', { entity: 'machines' })}
          />
        </View>
      ) : (
        <ShiftsTab date={date} onChangeDate={setDate} />
      )}
    </Screen>
  );
}

function ShiftsTab({ date, onChangeDate }: { date: Date; onChangeDate: (d: Date) => void }) {
  const navigation = useNavigation<any>();
  const dateKey = ymd(date);
  const isToday = dateKey === ymd(new Date());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['shiftsForDate', dateKey],
    queryFn: () => listShiftsForDate(dateKey),
  });

  return (
    <FlatList
      data={data ?? []}
      keyExtractor={(m) => m.machine_id}
      ListHeaderComponent={
        <View>
          <View style={styles.dateBar}>
            <Pressable
              onPress={() => onChangeDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1))}
              accessibilityRole="button"
              accessibilityLabel="Previous day"
              hitSlop={8}
              style={styles.dateBtn}
            >
              <Ionicons name="chevron-back" size={20} color={colors.indigo} />
            </Pressable>
            <Text style={styles.dateLabel}>
              {date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
              {isToday ? ' · Today' : ''}
            </Text>
            <Pressable
              onPress={() => onChangeDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1))}
              accessibilityRole="button"
              accessibilityLabel="Next day"
              hitSlop={8}
              style={styles.dateBtn}
            >
              <Ionicons name="chevron-forward" size={20} color={colors.indigo} />
            </Pressable>
          </View>
          {isLoading ? <ActivityIndicator color={colors.indigo} style={{ margin: spacing.lg }} /> : null}
          {isError ? <Text style={styles.errorText}>{describeDbError(error, 'Shifts')}</Text> : null}
        </View>
      }
      ListEmptyComponent={!isLoading ? <Text style={styles.emptyBody}>No machines.</Text> : null}
      renderItem={({ item }: { item: ShiftForDateRow }) => (
        <ListRow
          monoTitle
          title={item.machine_name}
          subtitle={
            item.status
              ? `${item.worker_name ?? 'Worker'} · ${item.order_code ?? 'No order'}`
              : 'No shift on this date'
          }
          pillLabel={item.status ? STATUS_LABEL[item.status] : isToday ? 'Start shift' : undefined}
          pillColor={item.status ? STATUS_COLOR[item.status] : colors.indigo}
          onPress={
            isToday && !item.status
              ? () => navigation.navigate('OpenShift', { machineId: item.machine_id, machineName: item.machine_name })
              : item.shift_id
                ? () => navigation.navigate('OpenShift', { machineId: item.machine_id, machineName: item.machine_name, openShiftId: item.shift_id })
                : undefined
          }
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  rows: { paddingHorizontal: spacing.lg },
  dateBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  dateBtn: { padding: spacing.xs },
  dateLabel: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.indigoDeep, fontFamily: fontFamily.mono },
  errorText: { paddingHorizontal: spacing.lg, color: colors.alert, fontSize: fontSize.secondary },
  emptyBody: { padding: spacing.xl, fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});

export default MachineWorkforceScreen;
