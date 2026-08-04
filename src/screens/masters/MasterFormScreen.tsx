/**
 * Generic, config-driven master form. Handles create and edit for any master
 * entity, plus archive/restore with a confirm step.
 *
 * Field rendering is driven entirely by the entity config's FieldConfig[], which
 * is why finishing partners get their select/number/linked fields without this
 * screen knowing anything about finishing partners.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Screen } from '../../components/ui/Screen';
import { AppButton } from '../../components/ui/AppButton';
import { TextField } from '../../components/forms/TextField';
import { SelectField } from '../../components/forms/SelectField';
import { StitchLine } from '../../components/ui/StitchLine';
import { ListRow } from '../../components/lists/ListRow';
import {
  getMaster,
  createMaster,
  updateMaster,
  archiveMaster,
  restoreMaster,
  listLinkedOptions,
  getVendorStats,
  getSupplierStats,
  getSupplierPurchaseOrders,
  getPartnerStats,
} from '../../api/endpoints/masters';
import { getMasterConfig } from '../../masters/configs';
import { useAuth } from '../../auth/AuthContext';
import { canAccessRole, isModuleEnabled } from '../../utils/permissions';
import { describeDbError, MODULE_DISABLED_MESSAGE } from '../../utils/errors';
import type { FieldConfig } from '../../masters/types';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';

type Values = Record<string, string | null>;

/** Cross-platform confirm — RN's Alert has no web implementation. */
function confirmAction(title: string, message: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Confirm', style: 'destructive', onPress: onConfirm },
  ]);
}

export function MasterFormScreen({ entity }: { entity?: string } = {}) {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const queryClient = useQueryClient();
  const { role, profile, enabledModules } = useAuth();

  // Same param-or-prop fallback as MasterListScreen: the Masters tabs render
  // the list inline, and the list navigates here via the stack with params.
  const entityKey: string = route.params?.entity ?? entity;
  const recordId: string | null = route.params?.id ?? null;
  const config = useMemo(() => getMasterConfig(entityKey), [entityKey]);
  const isEdit = !!recordId;

  const moduleOk = config.module
    ? isModuleEnabled(config.module, enabledModules, role)
    : true;
  const canWrite = canAccessRole(role, config.writeRoles) && moduleOk;
  const canArchive = canAccessRole(role, config.archiveRoles) && moduleOk;

  const [values, setValues] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isVendor = config.key === 'vendors';
  const isSupplier = config.key === 'suppliers';
  const isPartner = config.key === 'finishing_partners';

  // ---- Existing record (edit mode) ----
  const { data: record, isLoading } = useQuery({
    queryKey: ['master', config.table, recordId],
    queryFn: () => getMaster(config.table, recordId as string),
    enabled: isEdit && moduleOk,
  });

  const { data: detailData, isLoading: isDetailLoading, isError: isDetailError, error: detailError } = useQuery({
    queryKey: ['masterDetail', config.key, recordId],
    queryFn: async () => {
      if (!recordId) return null;
      if (isVendor) return getVendorStats(recordId);
      if (isSupplier) {
        const stats = await getSupplierStats(recordId);
        const purchaseOrders = await getSupplierPurchaseOrders(recordId);
        return { stats, purchaseOrders };
      }
      if (isPartner) return getPartnerStats(recordId);
      return null;
    },
    enabled: Boolean(recordId) && moduleOk,
  });

  useEffect(() => {
    if (!record) return;
    const next: Values = {};
    for (const f of config.fields) {
      const v = (record as any)[f.key];
      next[f.key] = v === null || v === undefined ? null : String(v);
    }
    setValues(next);
  }, [record, config.fields]);

  // ---- Options for `linked` fields ----
  const linkedFields = config.fields.filter((f) => f.type === 'linked');
  const { data: linkedOptions, isLoading: linkedLoading } = useQuery({
    queryKey: ['linkedOptions', config.table, linkedFields.map((f) => f.key).join(',')],
    queryFn: async () => {
      const out: Record<string, { value: string; label: string }[]> = {};
      for (const f of linkedFields) {
        if (!f.linkedTo) continue;
        out[f.key] = await listLinkedOptions(
          f.linkedTo.table,
          f.linkedTo.labelColumn,
          f.linkedTo.filter
        );
      }
      return out;
    },
    enabled: linkedFields.length > 0 && moduleOk,
  });

  // ---- Save ----
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {};
      for (const f of config.fields) {
        const raw = values[f.key] ?? null;
        if (f.type === 'number') {
          payload[f.key] = raw === null || raw === '' ? null : Number(raw);
        } else if (f.type === 'checkbox') {
          payload[f.key] = raw === 'true';
        } else {
          payload[f.key] = raw === '' ? null : raw;
        }
      }
      if (isEdit) return updateMaster(config.table, recordId as string, payload);
      if (!profile?.factory_id) throw new Error('No factory on your profile.');
      return createMaster(config.table, profile.factory_id, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['masters', config.table] });
      queryClient.invalidateQueries({ queryKey: ['master', config.table, recordId] });
      navigation.goBack();
    },
    onError: (e) => setFormError(describeDbError(e, config.singular)),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveMaster(config.table, recordId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['masters', config.table] });
      navigation.goBack();
    },
    onError: (e) => setFormError(describeDbError(e, config.singular)),
  });

  const restoreMutation = useMutation({
    mutationFn: () => restoreMaster(config.table, recordId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['masters', config.table] });
      navigation.goBack();
    },
    onError: (e) => setFormError(describeDbError(e, config.singular)),
  });

  function validate(): boolean {
    const next: Record<string, string> = {};
    for (const f of config.fields) {
      // Untouched fields are `undefined`, not null — both count as empty.
      const v = values[f.key] ?? null;
      if (f.required && (v === null || String(v).trim() === '')) {
        next[f.key] = `${f.label} is required.`;
        continue;
      }
      if (f.type === 'number' && v !== null && v !== '') {
        const n = Number(v);
        if (Number.isNaN(n)) next[f.key] = 'Enter a valid number.';
        else if (f.min !== undefined && n < f.min) next[f.key] = `Must be at least ${f.min}.`;
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function onSave() {
    setFormError(null);
    if (!validate()) return;
    saveMutation.mutate();
  }

  if (!moduleOk) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text style={styles.title}>{config.singular}</Text>
          <Text style={styles.body}>{MODULE_DISABLED_MESSAGE}</Text>
        </View>
      </Screen>
    );
  }

  if (isEdit && isLoading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.indigo} style={{ marginTop: spacing.xl }} />
      </Screen>
    );
  }

  const isArchived = !!(record as any)?.deleted_at;
  const busy = saveMutation.isPending || archiveMutation.isPending || restoreMutation.isPending;

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>
          {isEdit ? `Edit ${config.singular}` : `New ${config.singular}`}
        </Text>
        {isArchived ? (
          <Text style={styles.archivedNote}>
            This {config.singular.toLowerCase()} is archived and hidden from pickers.
          </Text>
        ) : null}

        <View style={styles.stitch}>
          <StitchLine />
        </View>

        {record ? (
          <View style={styles.detailSection}>
            <Text style={styles.detailTitle}>Details</Text>
            {isDetailLoading ? (
              <ActivityIndicator color={colors.indigo} />
            ) : isDetailError ? (
              <Text style={styles.detailError}>{describeDbError(detailError, 'Details')}</Text>
            ) : null}

            {detailData ? (
              <View style={styles.detailGrid}>
                {isVendor ? (
                  <>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Total orders</Text>
                      <Text style={styles.detailCardValue}>{(detailData as any).totalOrders}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Processing orders</Text>
                      <Text style={styles.detailCardValue}>{(detailData as any).processingOrders}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Remaining orders</Text>
                      <Text style={styles.detailCardValue}>{(detailData as any).remainingOrders}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Invoiced</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).invoiced).toLocaleString()}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Collected</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).collected).toLocaleString()}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Remaining</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).remaining).toLocaleString()}</Text>
                    </View>
                  </>
                ) : null}

                {isSupplier ? (
                  <>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Supplier name</Text>
                      <Text style={styles.detailCardValue}>{String((record as any)?.name ?? '—')}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Address</Text>
                      <Text style={styles.detailCardValue}>{String((record as any)?.address ?? '—')}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Payment day</Text>
                      <Text style={styles.detailCardValue}>{String((record as any)?.payment_day ?? '—')}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Total PO value</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).stats.totalAmount).toLocaleString()}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Paid</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).stats.paidAmount).toLocaleString()}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Remaining</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).stats.remainingAmount).toLocaleString()}</Text>
                    </View>
                  </>
                ) : null}

                {isPartner ? (
                  <>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Repeats in hand</Text>
                      <Text style={styles.detailCardValue}>{(detailData as any).repeatsInHand}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Total repeats</Text>
                      <Text style={styles.detailCardValue}>{(detailData as any).totalRepeats}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Completed repeats</Text>
                      <Text style={styles.detailCardValue}>{(detailData as any).completedRepeats}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Damage records</Text>
                      <Text style={styles.detailCardValue}>{(detailData as any).damageCount}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Damage quantity</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).damageQuantity).toLocaleString()}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Partner income</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).income).toLocaleString()}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Revenue this month</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).revenueMonth).toLocaleString()}</Text>
                    </View>
                    <View style={styles.detailCard}>
                      <Text style={styles.detailCardLabel}>Revenue overall</Text>
                      <Text style={styles.detailCardValue}>{Number((detailData as any).revenueTotal).toLocaleString()}</Text>
                    </View>
                  </>
                ) : null}
              </View>
            ) : null}

            {isPartner ? (
              <Text style={styles.detailNote}>
                Partner income is the amount owed to the contractor. Factory revenue via this partner is shown separately.
              </Text>
            ) : null}

            {isSupplier && detailData ? (
              <View style={styles.purchaseOrderList}>
                <Text style={styles.detailSubtitle}>Recent purchase orders</Text>
                {((detailData as any).purchaseOrders as any[]).length > 0 ? (
                  ((detailData as any).purchaseOrders as any[]).map((po) => (
                    <ListRow
                      key={po.id}
                      title={po.po_code}
                      subtitle={po.status}
                      caption={`Amount ${Number(po.amount ?? 0).toLocaleString()}`}
                    />
                  ))
                ) : (
                  <Text style={styles.detailEmpty}>No purchase orders yet for this supplier.</Text>
                )}
              </View>
            ) : null}
          </View>
        ) : null}

        {config.fields.map((f) => (
          <FieldRenderer
            key={f.key}
            field={f}
            value={values[f.key] ?? null}
            error={errors[f.key]}
            editable={canWrite}
            linkedOptions={linkedOptions?.[f.key] ?? []}
            linkedLoading={linkedLoading}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
          />
        ))}

        {formError ? <Text style={styles.formError}>{formError}</Text> : null}

        {!canWrite ? (
          <Text style={styles.body}>
            You have read-only access to {config.plural.toLowerCase()}.
          </Text>
        ) : (
          <AppButton
            title={isEdit ? 'Save changes' : `Create ${config.singular}`}
            onPress={onSave}
            loading={saveMutation.isPending}
            disabled={busy}
          />
        )}

        {isEdit && canArchive ? (
          <View style={styles.dangerZone}>
            {isArchived ? (
              <AppButton
                title="Restore"
                variant="secondary"
                onPress={() =>
                  confirmAction(
                    `Restore ${config.singular}`,
                    'This record will appear in lists and pickers again.',
                    () => restoreMutation.mutate()
                  )
                }
                loading={restoreMutation.isPending}
                disabled={busy}
              />
            ) : (
              <>
                <AppButton
                  title={`Archive ${config.singular}`}
                  variant="secondary"
                  onPress={() =>
                    confirmAction(
                      `Archive ${config.singular}`,
                      'It will be hidden from lists and pickers, but existing records that reference it stay intact. You can restore it later.',
                      () => archiveMutation.mutate()
                    )
                  }
                  loading={archiveMutation.isPending}
                  disabled={busy}
                />
                <Text style={styles.archiveHint}>
                  Master records are archived rather than deleted so orders and
                  ledgers that reference them keep resolving.
                </Text>
              </>
            )}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** Maps a FieldConfig to the right input. The only place field types branch. */
function FieldRenderer({
  field,
  value,
  error,
  editable,
  linkedOptions,
  linkedLoading,
  onChange,
}: {
  field: FieldConfig;
  value: string | null;
  error?: string;
  editable: boolean;
  linkedOptions: { value: string; label: string }[];
  linkedLoading?: boolean;
  onChange: (v: string | null) => void;
}) {
  if (field.type === 'checkbox') {
    return (
      <CheckboxField
        label={field.label}
        value={value === 'true'}
        onChange={editable ? (on) => onChange(String(on)) : () => {}}
        error={error}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <SelectField
        label={field.label}
        value={value}
        options={field.options ?? []}
        onChange={editable ? onChange : () => {}}
        required={field.required}
        error={error}
      />
    );
  }

  if (field.type === 'linked') {
    return (
      <SelectField
        label={field.label}
        value={value}
        options={linkedOptions}
        onChange={editable ? onChange : () => {}}
        required={field.required}
        error={error}
        loading={linkedLoading}
        allowClear
        clearLabel={field.linkedTo?.emptyLabel ?? 'None'}
        emptyHint="No eligible users found for this factory."
      />
    );
  }

  return (
    <TextField
      label={field.label}
      value={value ?? ''}
      onChangeText={editable ? onChange : () => {}}
      placeholder={field.placeholder}
      required={field.required}
      error={error}
      multiline={field.type === 'textarea'}
      numeric={field.type === 'number'}
      mono={field.mono}
    />
  );
}

/** Boolean field rendered as a labelled toggle chip (brass = on). */
function CheckboxField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  error?: string;
}) {
  // react-native-web (this version) doesn't map accessibilityState.checked, so
  // set aria-checked directly on web — selection must never be colour alone.
  const webAria = Platform.OS === 'web' ? ({ 'aria-checked': value } as object) : null;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => onChange(!value)}
        {...webAria}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: value }}
        style={({ pressed }) => [styles.checkbox, value && styles.checkboxOn, pressed && { opacity: 0.7 }]}
      >
        <View style={[styles.checkBox, value && styles.checkBoxOn]}>
          {value ? <Text style={styles.checkMark}>✓</Text> : null}
        </View>
        <Text style={[styles.checkboxLabel, value && styles.checkboxLabelOn]}>{label}</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  archivedNote: { marginTop: spacing.xs, fontSize: fontSize.secondary, color: colors.warning },
  stitch: { marginVertical: spacing.lg },
  body: { fontSize: fontSize.secondary, color: colors.slate, lineHeight: 20 },
  formError: {
    marginBottom: spacing.md,
    fontSize: fontSize.secondary,
    color: colors.alert,
    lineHeight: 20,
  },
  dangerZone: {
    marginTop: spacing.xxl,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  archiveHint: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  error: { marginTop: spacing.xs, fontSize: fontSize.caption, color: colors.alert },
  wrap: { marginBottom: spacing.lg },
  checkbox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  checkboxOn: { borderColor: colors.primary, backgroundColor: colors.tintTeal },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  checkBoxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: colors.indigoDeep, fontSize: fontSize.secondary, fontWeight: fontWeight.semibold },
  checkboxLabel: { fontSize: fontSize.secondary, color: colors.indigoDeep, flex: 1 },
  checkboxLabelOn: { fontWeight: fontWeight.medium },
  detailSection: {
    marginBottom: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.md,
  },
  detailTitle: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  detailError: {
    fontSize: fontSize.caption,
    color: colors.alert,
    marginBottom: spacing.sm,
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  detailCard: {
    flexBasis: '48%',
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  detailCardLabel: {
    fontSize: fontSize.caption,
    color: colors.slate,
    marginBottom: spacing.xs,
  },
  detailCardValue: {
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
  },
  detailSubtitle: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.indigoDeep,
    marginBottom: spacing.sm,
  },
  detailEmpty: {
    fontSize: fontSize.secondary,
    color: colors.slate,
  },
  detailNote: {
    fontSize: fontSize.caption,
    color: colors.slate,
    lineHeight: 18,
  },
  purchaseOrderList: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
});
