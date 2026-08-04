/**
 * Super Admin — toggle which modules are enabled for a factory.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Switch,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { saFactoryModules, saToggleModule } from '../../api/endpoints/factories';
import { describeDbError } from '../../utils/errors';
import { MODULE_LABEL, type ModuleKey } from '../../constants/roles';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
} from '../../constants/theme';

export function ModuleToggleScreen() {
  const route = useRoute<any>();
  const factoryId: string = route.params?.factoryId;
  const queryClient = useQueryClient();
  const [toggling, setToggling] = useState<ModuleKey | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['saFactoryModules', factoryId],
    queryFn: () => saFactoryModules(factoryId),
    enabled: !!factoryId,
  });

  async function onToggle(moduleKey: ModuleKey, next: boolean) {
    setToggling(moduleKey);
    try {
      await saToggleModule(factoryId, moduleKey, next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['saFactoryModules', factoryId] }),
        queryClient.invalidateQueries({ queryKey: ['saFactoryList'] }),
        queryClient.invalidateQueries({ queryKey: ['saFactoryDetail', factoryId] }),
      ]);
    } catch (e: any) {
      Alert.alert('Could not update module', describeDbError(e, 'Module'));
    } finally {
      setToggling(null);
    }
  }

  if (isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} />
      </Screen>
    );
  }

  if (isError) {
    return (
      <Screen>
        <Text style={styles.error}>{describeDbError(error, 'Modules')}</Text>
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <Text style={styles.lede}>
        Enable or disable modules for this factory. Changes take effect immediately for all users.
      </Text>
      <View style={styles.list}>
        {(data ?? []).map((mod) => (
          <View key={mod.module_id} style={styles.row}>
            <View style={styles.body}>
              <Text style={styles.name}>{MODULE_LABEL[mod.key] ?? mod.name}</Text>
              <Text style={styles.key}>{mod.key}</Text>
            </View>
            {toggling === mod.key ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Switch
                value={mod.enabled}
                onValueChange={(v) => onToggle(mod.key, v)}
                trackColor={{ false: colors.border, true: colors.brass }}
                thumbColor={colors.white}
              />
            )}
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lede: {
    padding: spacing.lg,
    fontSize: fontSize.secondary,
    color: colors.slate,
    lineHeight: 20,
  },
  list: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
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
  body: { flex: 1 },
  name: { fontSize: fontSize.body, fontWeight: fontWeight.medium, color: colors.indigoDeep },
  key: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
  error: { fontSize: fontSize.secondary, color: colors.alert },
});
