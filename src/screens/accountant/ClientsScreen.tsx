/**
 * Box 1 — Clients.
 *
 * The `vendors` table under its business name. The list carries each client's
 * receivable position; the detail adds the billing terms, the damage this client
 * is accountable for, and every invoice with its status and its photo.
 *
 * The summary panel reconciles by construction: total income is the sum of this
 * client's non-cancelled invoices, received is the payments recorded against
 * exactly those invoices, pending is what remains, and next pay date is the
 * earliest due date still unpaid.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { ListRow } from '../../components/lists/ListRow';
import {
  listClientSummaries,
  listClientInvoices,
  listClientDamages,
  type ClientSummary,
} from '../../api/endpoints/accounting';
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
  ProofThumb,
  invoicePill,
  styles,
} from './parts';

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export function AccountantClientsScreen() {
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.FINANCE_REPORTS, enabledModules, role);
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: ['acctClients'],
    queryFn: listClientSummaries,
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
    (c) => !search.trim() || c.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <Screen padded={false}>
      {/* The search field stays OUTSIDE the list: as a ListHeaderComponent it is
          re-created on every keystroke and loses focus mid-word. */}
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search clients" />
      <FlatList
        data={rows}
        keyExtractor={(c) => c.vendor_id}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            {q.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {q.isError ? <Text style={styles.error}>{describeDbError(q.error, 'Clients')}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          !q.isLoading && !q.isError ? <EmptyNote>No clients on file for this factory.</EmptyNote> : null
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.name}
            subtitle={`Pending ${money(item.pending)} of ${money(item.total_income)}`}
            caption={
              item.unpaid_count > 0
                ? `${item.unpaid_count} unpaid · next due ${shortDate(item.next_due_date)}`
                : 'All invoices settled'
            }
            pillLabel={item.unpaid_count > 0 ? `${item.unpaid_count} open` : 'Clear'}
            pillColor={item.unpaid_count > 0 ? colors.warning : colors.success}
            onPress={() =>
              navigation.navigate('AcctClientDetail', {
                vendorId: item.vendor_id,
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
export function AccountantClientDetailScreen() {
  const route = useRoute<any>();
  const vendorId: string = route.params?.vendorId;
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.FINANCE_REPORTS, enabledModules, role);

  const summaryQ = useQuery({
    queryKey: ['acctClients'],
    queryFn: listClientSummaries,
    enabled: moduleOn,
  });
  const invoicesQ = useQuery({
    queryKey: ['acctClientInvoices', vendorId],
    queryFn: () => listClientInvoices(vendorId),
    enabled: moduleOn && !!vendorId,
  });
  const damagesQ = useQuery({
    queryKey: ['acctClientDamages', vendorId],
    queryFn: () => listClientDamages(vendorId),
    enabled: moduleOn && !!vendorId,
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const client: ClientSummary | undefined = (summaryQ.data ?? []).find(
    (c) => c.vendor_id === vendorId
  );
  const invoices = invoicesQ.data ?? [];
  const damages = damagesQ.data ?? [];
  const loading = summaryQ.isLoading || invoicesQ.isLoading || damagesQ.isLoading;

  if (loading && !client) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} />
      </Screen>
    );
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={invoices}
        keyExtractor={(i) => i.invoice_id}
        refreshControl={
          <RefreshControl
            refreshing={invoicesQ.isRefetching}
            onRefresh={() => {
              summaryQ.refetch();
              invoicesQ.refetch();
              damagesQ.refetch();
            }}
            tintColor={colors.indigo}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text style={styles.title}>{client?.name ?? route.params?.name ?? 'Client'}</Text>
              <Text style={styles.subtitle}>
                {[client?.contact, client?.address].filter(Boolean).join(' · ') || 'No contact on file'}
              </Text>
            </View>

            {/* Billing type — whichever rates this client is actually on. */}
            <SectionTitle>Billing type</SectionTitle>
            <TileGrid>
              <Tile label="Rate per repeat" value={money(client?.rate_per_repeat)} />
              <Tile label="Rate per stitch" value={client?.rate_per_stitch == null ? '—' : String(client.rate_per_stitch)} />
              <Tile label="Price" value={money(client?.price)} />
            </TileGrid>

            <SectionTitle>Summary</SectionTitle>
            <TileGrid>
              <Tile label="Total income" value={money(client?.total_income)} />
              <Tile label="Received" value={money(client?.received)} tone={colors.success} />
              <Tile
                label="Pending"
                value={money(client?.pending)}
                tone={Number(client?.pending ?? 0) > 0 ? colors.warning : undefined}
              />
              <Tile label="Next pay date" value={shortDate(client?.next_due_date)} mono={false} />
            </TileGrid>

            <SectionTitle>Damages ({damages.length})</SectionTitle>
            {damages.length === 0 ? (
              <EmptyNote>No damage recorded against this client.</EmptyNote>
            ) : (
              damages.map((d) => (
                <FlatRow
                  key={d.damage_id}
                  code={d.order_code ?? 'Order'}
                  pill={{
                    label:
                      d.approval_status === 'approved'
                        ? 'Approved'
                        : d.approval_status === 'rejected'
                        ? 'Rejected'
                        : 'Pending',
                    color:
                      d.approval_status === 'approved'
                        ? colors.alert
                        : d.approval_status === 'rejected'
                        ? colors.slate
                        : colors.warning,
                  }}
                  lines={[
                    `${d.damage_type.replace(/_/g, ' ')} at ${d.stage_type.replace(/_/g, ' ')}`,
                    `Deduction ${money(d.deduction)} · ${Number(d.quantity_meters).toLocaleString()} m · ${shortDate(d.created_at)}`,
                    d.note,
                  ]}
                />
              ))
            )}

            <SectionTitle>Invoices ({invoices.length})</SectionTitle>
            {invoices.length === 0 ? (
              <EmptyNote>No invoices raised for this client yet.</EmptyNote>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <FlatRow
            code={item.invoice_code}
            pill={invoicePill(item.status, item.is_overdue)}
            lines={[
              `${money(item.amount)}${item.order_code ? ` · ${item.order_code}` : ''}`,
              `Issued ${shortDate(item.issued_at)} · due ${shortDate(item.due_date)}`,
              Number(item.paid_amount) > 0 ? `Received ${money(item.paid_amount)}` : null,
            ]}
            right={<ProofThumb path={item.photo_url} label="Invoice photo" />}
          />
        )}
      />
    </Screen>
  );
}
