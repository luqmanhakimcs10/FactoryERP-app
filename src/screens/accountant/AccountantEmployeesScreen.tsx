/**
 * Box 4 — Employees.
 *
 * EVERY role, not just workers: Worker, Manager, QA, Labour, Delivery Person,
 * Order Taker and the office roles all appear, because all of them get paid.
 * Only the owner (company_admin), the platform's super admin, and finishing
 * partners are excluded — the first two aren't payroll and the third is a
 * contractor with its own box and its own ledger.
 *
 * Total salary is computed by the same per-salary_type rules as the Salary Run
 * (per_stitch = the period's ledger net, per_day = daily rate x days worked,
 * per_month = flat), so a figure here and a figure there cannot disagree.
 */
import React, { useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { SearchBar } from '../../components/lists/SearchBar';
import { ListRow } from '../../components/lists/ListRow';
import { listEmployeeSummaries, type EmployeeSummary } from '../../api/endpoints/accounting';
import { SALARY_TYPE_LABEL } from '../../models/types';
import { ROLE_LABEL, MODULES, type Role } from '../../constants/roles';
import { useAuth } from '../../auth/AuthContext';
import { isModuleEnabled } from '../../utils/permissions';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import { colors } from '../../constants/theme';
import {
  money,
  count,
  shortDate,
  Tile,
  TileGrid,
  SectionTitle,
  EmptyNote,
  styles,
} from './parts';

function roleLabel(role: string) {
  return ROLE_LABEL[role as Role] ?? role.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export function AccountantEmployeesScreen() {
  const navigation = useNavigation<any>();
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: ['acctEmployees'],
    queryFn: () => listEmployeeSummaries(),
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
    (e) =>
      !term ||
      e.display_name.toLowerCase().includes(term) ||
      roleLabel(e.role).toLowerCase().includes(term)
  );

  return (
    <Screen padded={false}>
      {/* Outside the list on purpose — see the note in ClientsScreen. */}
      <SearchBar value={search} onChangeText={setSearch} placeholder="Search staff or role" />
      <FlatList
        data={rows}
        keyExtractor={(e) => e.user_id}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            {q.isLoading ? <ActivityIndicator color={colors.indigo} /> : null}
            {q.isError ? (
              <Text style={styles.error}>{describeDbError(q.error, 'Employees')}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !q.isLoading && !q.isError ? <EmptyNote>No employees on file for this factory.</EmptyNote> : null
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.display_name}
            subtitle={`${roleLabel(item.role)} · ${SALARY_TYPE_LABEL[item.salary_type]} ${money(
              item.salary_amount
            )}`}
            caption={`Salary ${money(item.total_salary)} · next pay ${shortDate(item.next_pay_date)}`}
            pillLabel={item.is_active ? 'Active' : 'Inactive'}
            pillColor={item.is_active ? colors.success : colors.slate}
            onPress={() =>
              navigation.navigate('AcctEmployeeDetail', {
                userId: item.user_id,
                name: item.display_name,
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
export function AccountantEmployeeDetailScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const userId: string = route.params?.userId;
  const { role, enabledModules } = useAuth();
  const moduleOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);

  const q = useQuery({
    queryKey: ['acctEmployees'],
    queryFn: () => listEmployeeSummaries(),
    enabled: moduleOn,
  });

  if (!moduleOn) {
    return (
      <Screen>
        <Text style={styles.disabled}>{MODULE_DISABLED_MESSAGE}</Text>
      </Screen>
    );
  }

  const emp: EmployeeSummary | undefined = (q.data ?? []).find((e) => e.user_id === userId);

  if (q.isLoading && !emp) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} />
      </Screen>
    );
  }
  if (!emp) {
    return (
      <Screen>
        <EmptyNote>This employee is no longer on file.</EmptyNote>
      </Screen>
    );
  }

  const isPieceRate = emp.salary_type === 'per_stitch';

  return (
    <Screen padded={false}>
      <FlatList
        data={[]}
        renderItem={null as any}
        refreshControl={
          <RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={colors.indigo} />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.header}>
              <Text style={styles.title}>{emp.display_name}</Text>
              <Text style={styles.subtitle}>
                {roleLabel(emp.role)}
                {emp.is_active ? '' : ' · inactive'}
              </Text>
            </View>

            <SectionTitle>Employee</SectionTitle>
            <TileGrid>
              <Tile label="Contact" value={emp.contact ?? '—'} mono={false} wide />
              <Tile label="Role" value={roleLabel(emp.role)} mono={false} />
              <Tile label="Pay type" value={SALARY_TYPE_LABEL[emp.salary_type]} mono={false} />
              <Tile
                label={isPieceRate ? 'Rate per stitch' : 'Salary amount'}
                value={isPieceRate ? String(emp.salary_amount) : money(emp.salary_amount)}
                wide
              />
            </TileGrid>

            <SectionTitle>Period {emp.period}</SectionTitle>
            <TileGrid>
              <Tile label="Bonus" value={money(emp.bonus)} tone={colors.success} />
              <Tile
                label="Fine (damage)"
                value={money(emp.fine)}
                tone={Number(emp.fine) > 0 ? colors.alert : undefined}
              />
              <Tile label="Leaves" value={`${count(emp.leave_days)} day(s)`} mono={false} />
              <Tile label="Leave requests" value={count(emp.leave_requests)} />
              <Tile label="Days worked" value={count(emp.days_worked)} />
              <Tile label="Stitches" value={count(emp.stitches)} />
              <Tile label="Loan deducted" value={money(emp.loan_deducted)} />
              <Tile label="Next pay date" value={shortDate(emp.next_pay_date)} mono={false} />
              <Tile label="Total salary" value={money(emp.total_salary)} wide />
            </TileGrid>

            <Text style={styles.empty}>
              {isPieceRate
                ? 'Piece-rate pay: base + bonus − fines − loan installment, from this period’s ledger entries.'
                : emp.salary_type === 'per_day'
                ? 'Daily pay: the daily rate times the days with a ledger entry this period.'
                : 'Monthly pay: the flat salary for the period. Bonus and fines are listed separately.'}
            </Text>

            <SectionTitle>Payroll</SectionTitle>
            <ListRow
              title="Open this employee’s ledger"
              subtitle="Shift entries, deductions and payment proof"
              onPress={() =>
                navigation.navigate('WorkerLedger', {
                  workerId: emp.user_id,
                  workerName: emp.display_name,
                })
              }
            />
          </View>
        }
      />
    </Screen>
  );
}
