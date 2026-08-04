/**
 * Screen 4 — Final Delivery Screen (Delivery Person).
 * Capture delivery proof photo & vendor digital signature to mark order complete.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { Screen } from '../../components/ui/Screen';
import { PhotoPicker, LocalPhoto } from '../../components/camera/PhotoPicker';
import { SignatureCapture } from '../../components/ui/SignatureCapture';
import { AppButton } from '../../components/ui/AppButton';
import { colors, spacing, fontSize, fontWeight, radius } from '../../constants/theme';
import { completeDelivery } from '../../api/endpoints/finishing';
import type { FinalDeliveryItem } from '../../models/finishingTypes';

export function FinalDeliveryScreen({ route, navigation }: any) {
  const item: FinalDeliveryItem = route.params?.item;
  const [deliveryPhotos, setDeliveryPhotos] = useState<LocalPhoto[]>([]);
  const [signature, setSignature] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleComplete() {
    if (!deliveryPhotos.length) {
      setError('Delivery proof photo is required.');
      return;
    }

    if (!signature) {
      setError('Vendor digital signature is required.');
      return;
    }

    try {
      setError(null);
      setSubmitting(true);
      await completeDelivery({
        orderId: item.order_id,
        deliveryPhotoUrl: deliveryPhotos[0].uri,
        deliverySignature: signature,
      });

      Alert.alert(
        'Order Completed!',
        `Order ${item.order_code} has been delivered to ${item.vendor_name} and marked COMPLETED.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (e: any) {
      setError(e?.message ?? 'Failed to complete delivery.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!item) {
    return (
      <Screen>
        <Text style={{ color: colors.alert }}>Order item not found.</Text>
      </Screen>
    );
  }

  return (
    <Screen style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.code}>{item.order_code}</Text>
          <Text style={styles.vendor}>Vendor: {item.vendor_name}</Text>
          <Text style={styles.meta}>Total Repeats: {item.completed_repeats} of {item.total_repeats} completed</Text>
        </View>

        <View style={styles.section}>
          <PhotoPicker
            label="Capture Delivery Proof Photo *"
            hint="Photo of delivered goods at vendor location"
            photos={deliveryPhotos}
            onChange={setDeliveryPhotos}
            multiple={false}
          />
        </View>

        <View style={styles.section}>
          <SignatureCapture
            onOK={(sig) => setSignature(sig)}
            onClear={() => setSignature(null)}
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <AppButton
          title={submitting ? 'Completing Order...' : 'Complete Order Delivery'}
          variant="brass"
          onPress={handleComplete}
          disabled={submitting || !deliveryPhotos.length || !signature}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: spacing.xxl },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.lg },
  code: { fontFamily: 'monospace', fontSize: fontSize.title, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  vendor: { fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.brass, marginVertical: 4 },
  meta: { fontSize: fontSize.secondary, color: colors.slate },
  section: { marginVertical: spacing.sm },
  error: { color: colors.alert, marginBottom: spacing.md, textAlign: 'center' },
});
