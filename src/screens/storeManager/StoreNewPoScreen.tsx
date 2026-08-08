/**
 * Store Manager raises a purchase order by hand.
 *
 * Two things distinguish this from procurement's own New PO screen: lines are
 * picked from the inventory list rather than typed as free text, and the PO must
 * be tagged to a specific procurement person before it can be saved.
 *
 * The assignee is required rather than optional because an untagged manual PO
 * lands in a shared queue with nobody accountable for it — which is the exact
 * situation the brief's "tag a specific Procurement person" exists to prevent.
 * The database refuses one too; this only stops the user reaching that error.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { SearchBar } from '../../components/lists/SearchBar';
import { EmptyState, Loading } from '../../components/ui/States';
import { matchesSearch } from '../../utils/search';
import { describeDbError } from '../../utils/errors';
import {
  listInventory,
  listProcurementUsers,
  createStorePo,
  ITEM_TYPE_LABEL,
  type InventoryItem,
} from '../../api/endpoints/storeManager';
import { colors, spacing, radius, fontSize, fontWeight, fontFamily } from '../../constants/theme';

interface Line {
  item: InventoryItem;
  quantity: string;
}

export function StoreNewPoScreen() {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();

  const [lines, setLines] = useState<Line[]>([]);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');

  const inventory = useQuery({ queryKey: ['inventoryItems'], queryFn: () => listInventory() });
  const people = useQuery({ queryKey: ['procurementUsers'], queryFn: listProcurementUsers });

  const pickable = useMemo(
    () =>
      (inventory.data ?? []).filter(
        (i) =>
          !lines.some((l) => l.item.id === i.id) &&
          matchesSearch(search, i.color_code, i.color_name, ITEM_TYPE_LABEL[i.item_type])
      ),
    [inventory.data, lines, search]
  );

  const save = useMutation({
    mutationFn: () =>
      createStorePo({
        items: lines.map((l) => ({
          inventory_item_id: l.item.id,
          quantity: Number(l.quantity),
        })),
        assignedTo: assignedTo!,
        note: note.trim() || null,
      }),
    onSuccess: (po) => {
      qc.invalidateQueries({ queryKey: ['smPos'] });
      qc.invalidateQueries({ queryKey: ['queueSummary'] });
      Alert.alert('Purchase order raised', `${po.po_code} is now on their dashboard.`);
      navigation.goBack();
    },
    onError: (e) => Alert.alert('Could not raise the PO', describeDbError(e, 'Purchase order')),
  });

  const linesValid = lines.length > 0 && lines.every((l) => Number(l.quantity) > 0);
  const canSave = linesValid && !!assignedTo && !save.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>Items</Text>

        {lines.map((line, idx) => (
          <View key={line.item.id} style={styles.lineRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.code}>{line.item.color_code}</Text>
              <Text style={styles.sub}>
                {ITEM_TYPE_LABEL[line.item.item_type]}
                {line.item.size_mm ? ` · ${line.item.size_mm} mm` : ''}
                {` · ${Number(line.item.quantity).toLocaleString()} ${line.item.unit} in stock`}
              </Text>
            </View>
            <TextInput
              style={styles.qtyInput}
              value={line.quantity}
              onChangeText={(v) =>
                setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, quantity: v } : l)))
              }
              keyboardType="decimal-pad"
              placeholder="Qty"
              placeholderTextColor={colors.inkSubtle}
              accessibilityLabel={`Quantity for ${line.item.color_code}`}
            />
            <Pressable
              onPress={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${line.item.color_code}`}
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={22} color={colors.slate} />
            </Pressable>
          </View>
        ))}

        {lines.length === 0 ? (
          <Text style={styles.hint}>No items yet — add one below.</Text>
        ) : null}

        <AppButton
          title={picking ? 'Done adding' : 'Add item'}
          variant="secondary"
          icon={picking ? 'checkmark' : 'add'}
          onPress={() => setPicking((p) => !p)}
        />

        {picking ? (
          <View style={styles.picker}>
            <SearchBar
              value={search}
              onChangeText={setSearch}
              placeholder="Search colour or type"
            />
            {inventory.isLoading ? <Loading /> : null}
            {pickable.slice(0, 40).map((item) => (
              <Pressable
                key={item.id}
                onPress={() => {
                  setLines((ls) => [...ls, { item, quantity: '' }]);
                  setSearch('');
                }}
                style={({ pressed }) => [styles.pickRow, pressed && styles.rowPressed]}
                accessibilityRole="button"
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.code}>{item.color_code}</Text>
                  <Text style={styles.sub}>
                    {ITEM_TYPE_LABEL[item.item_type]}
                    {item.size_mm ? ` · ${item.size_mm} mm` : ''}
                  </Text>
                </View>
                <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
              </Pressable>
            ))}
            {!inventory.isLoading && pickable.length === 0 ? (
              <EmptyState
                icon="cube-outline"
                title="Nothing left to add"
                message="Every matching item is already on this order."
              />
            ) : null}
          </View>
        ) : null}

        <Text style={styles.section}>Who will handle this</Text>
        <Text style={styles.hint}>
          The PO appears on their dashboard to go and execute.
        </Text>
        {people.isLoading ? <Loading /> : null}
        {(people.data ?? []).map((p) => (
          <Pressable
            key={p.id}
            onPress={() => setAssignedTo(p.id)}
            style={({ pressed }) => [
              styles.personRow,
              assignedTo === p.id && styles.personOn,
              pressed && styles.rowPressed,
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected: assignedTo === p.id }}
          >
            <Ionicons
              name={assignedTo === p.id ? 'radio-button-on' : 'radio-button-off'}
              size={20}
              color={assignedTo === p.id ? colors.primary : colors.slate}
            />
            <Text style={styles.person}>{p.display_name}</Text>
          </Pressable>
        ))}
        {!people.isLoading && (people.data?.length ?? 0) === 0 ? (
          <Text style={styles.warn}>
            This factory has no active procurement user, so a manual PO cannot be assigned yet.
          </Text>
        ) : null}

        <Text style={styles.section}>Note</Text>
        <TextInput
          style={[styles.input, { minHeight: 72 }]}
          value={note}
          onChangeText={setNote}
          multiline
          placeholder="Anything procurement should know"
          placeholderTextColor={colors.inkSubtle}
        />

        <AppButton
          title="Raise purchase order"
          onPress={() => save.mutate()}
          disabled={!canSave}
          loading={save.isPending}
          style={{ marginTop: spacing.lg }}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  section: {
    marginTop: spacing.md,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  hint: { fontSize: fontSize.caption, color: colors.inkSubtle },
  warn: { fontSize: fontSize.secondary, color: colors.alert },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.pressed },
  picker: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  personOn: { borderColor: colors.primary, backgroundColor: colors.tintTeal },
  person: { fontSize: fontSize.body, color: colors.ink },
  code: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    fontWeight: fontWeight.medium,
  },
  sub: { fontSize: fontSize.caption, color: colors.slate },
  qtyInput: {
    width: 84,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
    color: colors.ink,
    textAlign: 'right',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSize.body,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
});
