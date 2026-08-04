/**
 * Box 2 — Suppliers.
 *
 * Supplier info, their purchase orders with completion status / value /
 * quantity, and a next billing date.
 *
 * The billing date is derived from the supplier's agreed `payment_day` when
 * they have one — the only date the data states directly. Without agreed terms
 * it falls back to the oldest unpaid PO + 30 days, and the screen says which of
 * the two it used rather than presenting a bare date of unknown provenance.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { ListRow } from '../../components/lists/ListRow';
import {
  listSupplierSummaries,
  listSupplierPos,
  type SupplierSummary,
} from '../../api/endpoints/accounting';
import { PO_STATUS_LABEL } from '../../models/inventoryTypes';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { MODULES } from '../../constants/roles';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import { colors } from '../../constants/theme';
import {
  money,
  shortDate,
  Tile,
  TileGrid,
  SectionTitle,
  FlatRow,
  EmptyNote,
  styles,
} from './parts';

/** Paid/received POs are settled; everything else still owes the supplier. */
function poPill(status: string) {
  const label = (PO_STATUS_LABEL as Record<string, string>)[status] ?? status.replace(/_/g, ' ');
  if (status === 'paid' || status === 'received') return { label, color: colors.success };
  if (status === 'cancelled') return { label, color: colors.slate };
  if (status === 'approved') return { label, color: colors.warning };
  return { label, color: colors.indigo };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export function AccountantSuppliersScreen() {
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.FINANCE_REPORTS, enabledModules, role);
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: ['acctSuppliers'],
    queryFn: listSupplierSummaries,
    enabled: moduleOn,
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const rows = (q.data ?? []).filter(
    (s) => !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <Screen padded={false}>
      {/* Outside the list on purpose — see the note in ClientsScreen. */}
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search suppliers" />
      <FlatList
        data={rows}
        keyExtractor={(s) => s.supplier_id}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            {q.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {q.isError ? (
              <Text style={styles.error}>{describeDbError(q.error, 'Suppliers')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !q.isLoading && !q.isError ? <EmptyNote>No suppliers on file for this factory.</EmptyNote> : null
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.name}
            subtitle={`Outstanding ${money(item.outstanding)} of ${money(item.po_value)}`}
            caption={`${item.po_count} PO${item.po_count === 1 ? '' : 's'} · next billing ${shortDate(
              item.next_billing_date
            )}`}
            pillLabel={item.unpaid_po_count > 0 ? `${item.unpaid_po_count} open` : 'Clear'}
            pillColor={item.unpaid_po_count > 0 ? colors.warning : colors.success}
            onPress={() =>
              navigation.navigate('AcctSupplierDetail', {
                supplierId: item.supplier_id,
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
export function AccountantSupplierDetailScreen() {
  const route = useRoute<any>();
  const supplierId: string = route.params?.supplierId;
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.FINANCE_REPORTS, enabledModules, role);

  const summaryQ = useQuery({
    queryKey: ['acctSuppliers'],
    queryFn: listSupplierSummaries,
    enabled: moduleOn,
  });
  const posQ = useQuery({
    queryKey: ['acctSupplierPos', supplierId],
    queryFn: () => listSupplierPos(supplierId),
    enabled: moduleOn && !!supplierId,
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const supplier: SupplierSummary | undefined = (summaryQ.data ?? []).find(
    (s) => s.supplier_id === supplierId
  );
  const pos = posQ.data ?? [];

  if (summaryQ.isLoading && !supplier) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={pos}
        keyExtractor={(p) => p.po_id}
        refreshControl={
          <RefreshControl
            refreshing={posQ.isRefetching}
            onRefresh={() => {
              summaryQ.refetch();
              posQ.refetch();
            }}
            tintColor={colors.indigo}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text style={styles.title}>{supplier?.name ?? route.params?.name ?? 'Supplier'}</Text>
              <Text style={styles.subtitle}>
                {[supplier?.contact, supplier?.address].filter(Boolean).join(' · ') ||
                  'No contact on file'}
              </Text>
            </View>

            <SectionTitle>Supplier</SectionTitle>
            <TileGrid>
              <Tile
                label="Payment day"
                value={supplier?.payment_day ? `Day ${supplier.payment_day}` : 'Not agreed'}
                mono={false}
              />
              <Tile
                label="Next billing date"
                value={shortDate(supplier?.next_billing_date)}
                mono={false}
              />
              <Tile label="PO value" value={money(supplier?.po_value)} />
              <Tile label="Paid" value={money(supplier?.paid)} tone={colors.success} />
              <Tile
                label="Outstanding"
                value={money(supplier?.outstanding)}
                tone={Number(supplier?.outstanding ?? 0) > 0 ? colors.warning : undefined}
                wide
              />
            </TileGrid>
            <Text style={styles.empty}>
              {supplier?.payment_day
                ? `Billing date is day ${supplier.payment_day} of the month, per the agreed payment day.`
                : 'No payment day agreed — the date shown is the oldest unpaid PO plus 30 days.'}
            </Text>

            <SectionTitle>Purchase orders ({pos.length})</SectionTitle>
            {posQ.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {posQ.isError ? (
              <Text style={styles.error}>{describeDbError(posQ.error, 'Purchase orders')}</Text>
            ) : null}
            {!posQ.isLoading && pos.length === 0 ? (
              <EmptyNote>No purchase orders raised with this supplier yet.</EmptyNote>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <FlatRow
            code={item.po_code}
            pill={poPill(item.status)}
            lines={[
              `${item.amount == null ? 'No amount on bill' : money(item.amount)} · ${Number(
                item.quantity_meters
              ).toLocaleString()} m across ${item.item_count} line${item.item_count === 1 ? '' : 's'}`,
              `Raised ${shortDate(item.created_at)}${
                item.paid_at ? ` · paid ${shortDate(item.paid_at)}` : ''
              }`,
            ]}
          />
        )}
      />
    </Screen>
  );
}
