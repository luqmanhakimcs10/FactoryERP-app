/**
 * Generic, config-driven master list.
 *
 * Renders any master entity from its MasterEntityConfig — searchable, bordered
 * flat rows, "+" in the header to create, tap a row to edit. Archived rows are
 * hidden behind a toggle so a retired vendor can still be found and restored.
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { ListRow } from '../../components/lists/ListRow';
import { SelectField } from '../../components/forms/SelectField';
import { listMasters } from '../../api/endpoints/masters';
import { getMasterConfig } from '../../masters/configs';
import { useAuth } from '../../auth/AuthContext';
import { canAccessRole, isModuleEnabled } from '../../utils/permissions';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
} from '../../constants/theme';

export function MasterListScreen({ entity }: { entity?: string } = {}) {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();

  // The entity comes from navigation params when this is a stack screen
  // (role home -> MasterList), or from the `entity` prop when embedded inside
  // the Masters tabs. Param wins so nested renders stay explicit.
  const entityKey: string = route.params?.entity ?? entity;
  const config = useMemo(() => getMasterConfig(entityKey), [entityKey]);

  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [machineType, setMachineType] = useState<string | null>(null);

  const moduleOk = config.module
    ? isModuleEnabled(config.module, enabledModules, role)
    : true;

  const canWrite = canAccessRole(role, config.writeRoles) && moduleOk;

  const machineTypeOptions = useMemo(() => {
    const field = config.fields.find((f) => f.key === 'machine_type');
    return field?.options ?? [];
  }, [config.fields]);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['masters', config.table, search, showArchived, machineType],
    queryFn: () =>
      listMasters({
        table: config.table,
        searchField: config.searchField,
        search,
        includeArchived: showArchived,
        filter: machineType ? { machine_type: machineType } : undefined,
      }),
    enabled: moduleOk,
  });

  // Module off for this factory: plain message, never a crash or raw error.
  if (!moduleOk) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>{config.plural}</Text>
          <Text style={styles.emptyBody}>{MODULE_DISABLED_MESSAGE}</Text>
        </View>
      </Screen>
    );
  }

  const rows = data ?? [];

  function subtitleFor(row: Record<string, any>): string | undefined {
    const parts = (config.subtitleFields ?? [])
      .map((f) => row[f])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
      .map((v) => String(v).replace(/_/g, ' '));
    return parts.length ? parts.join(' · ') : undefined;
  }

  return (
    <Screen padded={false}>
      <View style={styles.toolbar}>
        {config.key === 'machines' ? (
          <SelectField
            label="Machine type"
            value={machineType}
            options={[{ value: '', label: 'All' }, ...machineTypeOptions]}
            onChange={(v) => setMachineType(v)}
            allowClear
            clearLabel="All"
            emptyHint="No machine types available."
          />
        ) : null}
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder={`Search ${config.plural.toLowerCase()}`}
        />
        <View style={styles.toolbarRow}>
          <Pressable
            onPress={() => setShowArchived((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ selected: showArchived }}
            style={({ pressed }) => [
              styles.toggle,
              showArchived && styles.toggleOn,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.toggleText, showArchived && styles.toggleTextOn]}>
              {showArchived ? 'Showing archived' : 'Show archived'}
            </Text>
          </Pressable>

          {canWrite ? (
            <Pressable
              onPress={() =>
                navigation.navigate('MasterForm', { entity: config.key, id: null })
              }
              accessibilityLabel={`Add ${config.singular}`}
              accessibilityRole="button"
              style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
            >
              <Text style={styles.addBtnText}>+ New {config.singular}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.emptyBody}>{describeDbError(error, config.singular)}</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.indigo} />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No {config.plural.toLowerCase()} yet</Text>
              <Text style={styles.emptyBody}>
                {search
                  ? 'No matches for this search.'
                  : canWrite
                    ? `Tap "+ New ${config.singular}" to add the first one.`
                    : 'Nothing has been added for this factory yet.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const archived = !!item.deleted_at;
            return (
              <ListRow
                title={String(item[config.titleField] ?? '(unnamed)')}
                subtitle={subtitleFor(item)}
                monoTitle={config.key === 'machines'}
                pillLabel={archived ? 'Archived' : undefined}
                pillColor={colors.slate}
                onPress={() =>
                  navigation.navigate('MasterForm', { entity: config.key, id: item.id })
                }
              />
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolbar: { backgroundColor: colors.canvas },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  toggle: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleOn: { backgroundColor: colors.slate, borderColor: colors.slate },
  toggleText: { fontSize: fontSize.caption, color: colors.slate, fontWeight: fontWeight.medium },
  toggleTextOn: { color: colors.white },
  addBtn: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: 999,
    backgroundColor: colors.brass,
  },
  addBtnText: {
    color: colors.indigoDeep,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
  },
  pressed: { opacity: 0.75 },
  center: { padding: spacing.xl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate, textAlign: 'center' },
});
