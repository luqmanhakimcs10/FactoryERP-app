/**
 * Machine box — Floor Manager.
 *
 * Two rows into existing screens: shift assignment (MachineListScreen, tap a
 * machine to open a shift for it) and the machine registry (the generic
 * Masters CRUD screen, entity 'machines' — previously reached from a footer
 * row on the old dashboard, now living here since that footer is gone).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { ListRow } from '../../components/lists/ListRow';
import { colors, spacing, fontSize, fontWeight } from '../../constants/theme';

export function MachineBoxScreen() {
  const navigation = useNavigation<any>();

  return (
    <Screen padded={false}>
      <Text style={styles.sectionTitle}>Machine</Text>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rows: { paddingHorizontal: spacing.lg },
});

export default MachineBoxScreen;
