/**
 * Damages box — Floor Manager.
 *
 * Every damage record in the factory (listFactoryDamage — factory-wide by
 * RLS, same scope every role already reads order-by-order). Read-only: damage
 * is recorded at QA/collection/return, not here.
 */
import React from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '../../components/ui/Screen';
import { StatusPill } from '../../components/ui/StatusPill';
import { listFactoryDamage } from '../../api/endpoints/orders';
import { describeDbError } from '../../utils/errors';
import { DAMAGE_TYPE_LABEL } from '../../models/orderTypes';
import type { DamageRecord } from '../../models/orderTypes';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
} from '../../constants/theme';

const RESPONSIBLE_COLOR: Record<string, string> = {
  vendor: colors.accountVendor,
  worker: colors.accountWorker,
  partner: colors.accountPartner,
};

export function DamagesBoxScreen() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['factoryDamage'],
    queryFn: listFactoryDamage,
  });

  return (
    <Screen padded={false}>
      <FlatList
        data={data ?? []}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View>
            {isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {isError ? <Text style={styles.error}>{describeDbError(error, 'Damage records')}</Text> : null}
          </View>
        }
        ListEmptyComponent={!isLoading ? <Text style={styles.emptyBody}>No damage recorded.</Text> : null}
        renderItem={({ item }) => <DamageCard damage={item} />}
      />
    </Screen>
  );
}

function DamageCard({ damage }: { damage: DamageRecord }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{DAMAGE_TYPE_LABEL[damage.damage_type] ?? damage.damage_type}</Text>
        <StatusPill
          label={`${damage.responsible_type} accountable`}
          color={RESPONSIBLE_COLOR[damage.responsible_type] ?? colors.slate}
        />
      </View>
      <Text style={styles.cardLine}>
        {damage.orders?.order_code ?? '—'} · {damage.stage_type.replace(/_/g, ' ')}
        {damage.sheets ? ` · Sheet ${damage.sheets.sheet_number}` : ''}
        {damage.repeats ? ` · ${damage.repeats.repeat_code}` : ''}
      </Text>
      {damage.note ? <Text style={styles.cardLine}>{damage.note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg },
  emptyBody: { fontSize: fontSize.secondary, color: colors.slate },
  error: { color: colors.alert, fontSize: fontSize.secondary },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: 4 },
  cardTitle: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep, flexShrink: 1 },
  cardLine: { marginTop: 2, fontSize: fontSize.caption, color: colors.slate },
});

export default DamagesBoxScreen;
