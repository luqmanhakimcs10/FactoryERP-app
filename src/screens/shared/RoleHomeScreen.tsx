/**
 * Role home. Still a shell for business screens (those land in Phase 3+), but
 * from Phase 2 it also lists the master-data screens this role can reach.
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { DashboardHeader } from '../../components/ui/DashboardHeader';
import { TaskBanners } from '../../components/ui/TaskBanners';
import { StitchLine } from '../../components/ui/StitchLine';
import { ListRow } from '../../components/lists/ListRow';
import { useAuth } from '../../auth/AuthContext';
import { ROLES, ROLE_HOME_TITLE, ROLE_LABEL, MODULE_LABEL, MODULES } from '../../constants/roles';
import { mastersForRole } from '../../navigation/roles/roleMasters';
import { getMasterConfig } from '../../masters/configs';
import { isModuleEnabled } from '../../utils/permissions';
import { colors, spacing, fontSize, fontWeight, radius } from '../../constants/theme';

export function RoleHomeScreen() {
  const navigation = useNavigation<any>();
  const { role, profile, factory, enabledModules } = useAuth();
  if (!role) return null;

  // Hide a master entity whose module is off for this factory — RLS would
  // reject it anyway, so don't offer a dead end.
  const masters = mastersForRole(role)
    .map((key) => getMasterConfig(key))
    .filter((cfg) => !cfg.module || isModuleEnabled(cfg.module, enabledModules, role));

  const workforceOn = isModuleEnabled(MODULES.MACHINE_WORKFORCE, enabledModules, role);
  const showLaterNote =
    role !== 'company_admin' && role !== 'accountant' && role !== 'super_admin';

  return (
    <Screen padded={false}>
      <DashboardHeader navigation={navigation} />
      <View style={{ paddingHorizontal: 16, paddingTop: 16 }}><TaskBanners /></View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>{ROLE_HOME_TITLE[role]}</Text>
          <Text style={styles.subtitle}>
            {ROLE_LABEL[role]} · {profile?.display_name}
          </Text>
        </View>

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {/* The owner oversees the whole spine, so they get entry points to each
            role's queue. Other roles land directly on their own queue. */}
        {role === 'company_admin' ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Operations</Text>
            <View style={styles.rows}>
              <ListRow
                title="Orders"
                subtitle="Capture and track vendor orders"
                onPress={() => navigation.navigate('MyOrders')}
              />
              <ListRow
                title="Inspection queue"
                subtitle="Incoming cloth inspection and repeat coding"
                onPress={() => navigation.navigate('InspectionQueue')}
              />
              <ListRow
                title="Second-QA queue"
                subtitle="Stage sequences and job cards"
                onPress={() => navigation.navigate('SecondQAQueue')}
              />
              <ListRow
                title="Purchase orders"
                subtitle="Procurement queue and PO execution"
                onPress={() => navigation.navigate('PoQueue')}
              />
              <ListRow
                title="Thread stock"
                subtitle="Stock levels, GRNs, issues and audits"
                onPress={() => navigation.navigate('StockHome')}
              />
              <ListRow
                title="Approvals inbox"
                subtitle="Expenses, damage deductions and bonus slab changes"
                onPress={() => navigation.navigate('ApprovalsInbox')}
              />
              <ListRow
                title="Reports"
                subtitle="P&L, per-order profitability, leakage, productivity, uptime"
                onPress={() => navigation.navigate('ReportsHub')}
              />
              <ListRow
                title="Ledgers"
                subtitle="Payables, receivables, salary and loans"
                onPress={() => navigation.navigate('LedgersHome')}
              />
              <ListRow
                title="Extra permissions"
                subtitle="Grant capability beyond a user's base role"
                onPress={() => navigation.navigate('ExtraPermissions')}
              />
              <ListRow
                title="Masters"
                subtitle="Clients, suppliers, machines, finishing partners, employees"
                onPress={() => navigation.navigate('MastersTabs')}
              />
              {workforceOn ? (
                <>
                  <ListRow
                    title="Machine assignment"
                    subtitle="Assign workers and orders to machines"
                    onPress={() => navigation.navigate('MachineList')}
                  />
                  <ListRow
                    title="Shift close walk (fallback)"
                    subtitle="Close shifts when the floor manager is unavailable"
                    onPress={() => navigation.navigate('ShiftCloseQueue')}
                  />
                  <ListRow
                    title="Salary run"
                    subtitle="Review and finalize worker payroll"
                    onPress={() => navigation.navigate('SalaryRun')}
                  />
                  <ListRow
                    title="Bonus slabs"
                    subtitle="Daily stitch thresholds and bonus amounts"
                    onPress={() => navigation.navigate('BonusSlabs')}
                  />
                </>
              ) : null}
            </View>
          </View>
        ) : null}

        {role === 'company_admin' ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Finishing & Delivery</Text>
            <View style={styles.rows}>
              <ListRow
                title="Handoff queue"
                subtitle="Dispatch repeats to finishing partners or handlers"
                onPress={() => navigation.navigate('HandoffQueue')}
              />
              <ListRow
                title="Return queue"
                subtitle="Inspect incoming repeats from finishing stages"
                onPress={() => navigation.navigate('ReturnQueue')}
              />
              <ListRow
                title="Collection QA queue"
                subtitle="Inspect returned repeats before advancing stages"
                onPress={() => navigation.navigate('CollectionQueue')}
              />
              <ListRow
                title="SLA alerts"
                subtitle="Overdue finishing-stage handoffs"
                onPress={() => navigation.navigate('SlaAlerts')}
              />
              <ListRow
                title="Final delivery queue"
                subtitle="Orders ready for vendor delivery"
                onPress={() => navigation.navigate('FinalDeliveryQueue')}
              />
            </View>
          </View>
        ) : null}

        {role === 'accountant' ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Operations</Text>
            <View style={styles.rows}>
              <ListRow
                title="Purchase orders"
                subtitle="Payables awaiting payment"
                onPress={() => navigation.navigate('PoQueue')}
              />
              {workforceOn ? (
                <ListRow
                  title="Salary run"
                  subtitle="Shift-close ledger entries and payroll finalization"
                  onPress={() => navigation.navigate('SalaryRun')}
                />
              ) : null}
            </View>
          </View>
        ) : null}

        {role !== ROLES.COMPANY_ADMIN && masters.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Master data</Text>
            <View style={styles.rows}>
              {masters.map((cfg) => (
                <ListRow
                  key={cfg.key}
                  title={cfg.plural}
                  subtitle={
                    cfg.key === 'vendors'
                      ? 'Customers who place orders'
                      : cfg.key === 'suppliers'
                        ? 'Thread and material sellers'
                        : cfg.key === 'machines'
                          ? 'Machine registry'
                          : 'External finishing contractors'
                  }
                  onPress={() => navigation.navigate('MasterList', { entity: cfg.key })}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Factory</Text>
          <Text style={styles.cardValue}>
            {factory?.name ?? (role === 'super_admin' ? 'Platform (all factories)' : '—')}
          </Text>

          <Text style={[styles.cardLabel, { marginTop: spacing.lg }]}>Enabled modules</Text>
          {role === 'super_admin' ? (
            <Text style={styles.cardValue}>All (tenancy management)</Text>
          ) : enabledModules.length ? (
            <View style={styles.pills}>
              {enabledModules.map((m) => (
                <View key={m} style={styles.pill}>
                  <Text style={styles.pillText}>{MODULE_LABEL[m]}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.cardValue}>None enabled for this factory</Text>
          )}
        </View>

        {showLaterNote ? (
          <Text style={styles.note}>This role's business screens arrive in a later phase.</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xl },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  subtitle: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.slate },
  stitch: { marginVertical: spacing.lg, paddingHorizontal: spacing.xl },
  section: { marginBottom: spacing.xl },
  sectionLabel: {
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rows: { paddingHorizontal: spacing.xl },
  card: {
    marginHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  cardLabel: {
    fontSize: fontSize.caption,
    fontWeight: fontWeight.medium,
    color: colors.slate,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardValue: { marginTop: spacing.xs, fontSize: fontSize.body, color: colors.indigoDeep },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  pill: {
    backgroundColor: colors.indigo,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  pillText: { color: colors.white, fontSize: fontSize.caption, fontWeight: fontWeight.medium },
  note: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    fontSize: fontSize.secondary,
    color: colors.slate,
    fontStyle: 'italic',
  },
});
