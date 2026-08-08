/**
 * "On Machine" — which colours are mounted on one machine right now.
 *
 * A component rather than a section written into a screen, because machine
 * detail exists in more than one place (the accountant's machine view, the floor
 * manager's machine box) and the answer to "what is loaded on this machine" must
 * not depend on which screen is asking.
 *
 * Renders nothing at all when the machine is idle. An empty "On Machine (0)"
 * header on every idle machine would be noise on the one screen where a mounted
 * colour needs to stand out.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { listMountedItems, ITEM_TYPE_LABEL } from '../../api/endpoints/storeManager';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

export function OnMachinePanel({ machineId }: { machineId: string }) {
  const { data, isError } = useQuery({
    queryKey: ['mountedItems', machineId],
    queryFn: () => listMountedItems(machineId),
    enabled: !!machineId,
  });

  // A failed fetch stays silent too: this is supporting detail on someone else's
  // screen, and an error card here would look like the machine itself is broken.
  if (isError || !data || data.length === 0) return null;

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>On machine</Text>
      {data.map((m) => (
        <View key={m.id} style={styles.row}>
          <Ionicons name="ellipse" size={10} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.code}>{m.color_code}</Text>
            <Text style={styles.sub}>
              {ITEM_TYPE_LABEL[m.item_type] ?? m.item_type}
              {m.color_name ? ` · ${m.color_name}` : ''}
              {m.order_code ? ` · ${m.order_code}` : ''}
            </Text>
          </View>
          <Text style={styles.qty}>
            {Number(m.quantity).toLocaleString()} {m.unit}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  heading: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  sub: { fontSize: fontSize.caption, color: colors.slate },
  qty: { fontFamily: fontFamily.mono, fontSize: fontSize.secondary, color: colors.ink },
});
