/**
 * Box 5 — Machines.
 *
 * Machine info and total hours run. Hours are the sum of (close − open) over
 * that machine's CLOSED shifts; open shifts are counted but not accrued to
 * "now", so the total reconciles exactly against the shift records instead of
 * creeping between two loads of the same screen. The detail lists those shifts
 * with their individual minutes, which is what makes the total checkable by
 * hand.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { ListRow } from '../../components/lists/ListRow';
import {
  listMachineSummaries,
  listMachineShifts,
  type MachineSummary,
} from '../../api/endpoints/accounting';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import { OnMachinePanel } from '../../components/ui/OnMachinePanel';
import { colors, spacing } from '../../constants/theme';
import {
  count,
  shortDate,
  Tile,
  TileGrid,
  SectionTitle,
  FlatRow,
  EmptyNote,
  styles,
} from './parts';

const machineType = (t: string) => t.replace(/_/g, ' ');

function hours(n: number | null | undefined) {
  if (n == null) return '—';
  return `${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} h`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export function AccountantMachinesScreen() {
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: ['acctMachines'],
    queryFn: listMachineSummaries,
    enabled: moduleOn,
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const term = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter(
    (m) =>
      !term || m.name.toLowerCase().includes(term) || machineType(m.machine_type).includes(term)
  );

  return (
    <Screen padded={false}>
      {/* Outside the list on purpose — see the note in ClientsScreen. */}
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search machines" />
      <FlatList
        data={rows}
        keyExtractor={(m) => m.machine_id}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            {q.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {q.isError ? (
              <Text style={styles.error}>{describeDbError(q.error, 'Machines')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !q.isLoading && !q.isError ? <EmptyNote>No machines on file for this factory.</EmptyNote> : null
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.name}
            monoTitle
            subtitle={`${machineType(item.machine_type)} · ${hours(item.total_hours)} total`}
            caption={`${item.closed_shifts} closed shift${item.closed_shifts === 1 ? '' : 's'}${
              item.open_shifts > 0 ? ` · ${item.open_shifts} open` : ''
            }`}
            pillLabel={item.open_shifts > 0 ? 'Running' : 'Idle'}
            pillColor={item.open_shifts > 0 ? colors.primary : colors.inkMuted}
            onPress={() =>
              navigation.navigate('AcctMachineDetail', {
                machineId: item.machine_id,
                name: item.name,
              })
            }
          />
        )}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
export function AccountantMachineDetailScreen() {
  const route = useRoute<any>();
  const machineId: string = route.params?.machineId;
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);

  const summaryQ = useQuery({
    queryKey: ['acctMachines'],
    queryFn: listMachineSummaries,
    enabled: moduleOn,
  });
  const shiftsQ = useQuery({
    queryKey: ['acctMachineShifts', machineId],
    queryFn: () => listMachineShifts(machineId),
    enabled: moduleOn && !!machineId,
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const machine: MachineSummary | undefined = (summaryQ.data ?? []).find(
    (m) => m.machine_id === machineId
  );
  const shifts = shiftsQ.data ?? [];

  if (summaryQ.isLoading && !machine) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={shifts}
        keyExtractor={(s) => s.shift_id}
        refreshControl={
          <RefreshControl
            refreshing={shiftsQ.isRefetching}
            onRefresh={() => {
              summaryQ.refetch();
              shiftsQ.refetch();
            }}
            tintColor={colors.indigo}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text style={styles.title}>{machine?.name ?? route.params?.name ?? 'Machine'}</Text>
              <Text style={styles.subtitle}>
                {machine ? machineType(machine.machine_type) : 'Machine'}
              </Text>
            </View>

            {/* What is loaded on this machine right now — driven by material
                issue against its active job card. Renders nothing when idle. */}
            <View style={{ marginBottom: spacing.lg }}>
              <OnMachinePanel machineId={machineId} />
            </View>

            <SectionTitle>Machine</SectionTitle>
            <TileGrid>
              <Tile label="Total hours" value={hours(machine?.total_hours)} wide />
              <Tile label="Total minutes" value={count(machine?.total_minutes)} />
              <Tile label="Shifts recorded" value={count(machine?.shift_count)} />
              <Tile label="Closed" value={count(machine?.closed_shifts)} />
              <Tile label="Open" value={count(machine?.open_shifts)} />
              <Tile label="Flagged idle" value={count(machine?.idle_shifts)} />
              <Tile label="Last shift" value={shortDate(machine?.last_shift_at)} mono={false} />
            </TileGrid>
            <Text style={styles.empty}>
              Hours count closed shifts only — an open shift has no close time to measure against
              yet, so it is listed below but adds nothing to the total.
            </Text>

            <SectionTitle>Shifts ({shifts.length})</SectionTitle>
            {shiftsQ.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {shiftsQ.isError ? (
              <Text style={styles.error}>{describeDbError(shiftsQ.error, 'Shifts')}</Text>
            ) : null}
            {!shiftsQ.isLoading && shifts.length === 0 ? (
              <EmptyNote>No shifts recorded on this machine.</EmptyNote>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <FlatRow
            code={item.worker_name ?? 'Unassigned'}
            mono={false}
            pill={{
              label:
                item.status === 'closed' ? 'Closed' : item.status === 'open' ? 'Open' : 'Flagged idle',
              color:
                item.status === 'closed'
                  ? colors.success
                  : item.status === 'open'
                  ? colors.brass
                  : colors.slate,
            }}
            lines={[
              `${new Date(item.opened_at).toLocaleString()} → ${
                item.closed_at ? new Date(item.closed_at).toLocaleString() : 'still open'
              }`,
              item.minutes == null
                ? 'Not counted towards total hours'
                : `${Number(item.minutes).toLocaleString()} min · ${count(item.stitches)} stitches`,
            ]}
          />
        )}
      />
    </Screen>
  );
}
