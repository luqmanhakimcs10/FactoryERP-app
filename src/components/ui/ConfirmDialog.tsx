/**
 * A confirmation popup that works on every platform this app ships to.
 *
 * `Alert.alert` has no react-native-web implementation — it is a no-op there —
 * so every screen that guarded a destructive action with it was, on web,
 * performing the action with no confirmation at all or (worse) silently doing
 * nothing. Deactivating a factory blocks login for all of its users, so that
 * confirmation has to actually appear.
 */
import React from 'react';
import { View, Text, Modal, Pressable, StyleSheet } from 'react-native';
import { AppButton } from './AppButton';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  /** Label for the affirmative button. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Renders the confirm button in the alert colour. */
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  loading,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.scrim}>
        {/* Not a Pressable scrim: a confirmation this consequential should be
            dismissed by a deliberate Cancel, not by a stray tap beside it. */}
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              disabled={loading}
              style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.cancelLabel}>{cancelLabel}</Text>
            </Pressable>
            <AppButton
              title={confirmLabel}
              variant={destructive ? 'alert' : 'primary'}
              onPress={onConfirm}
              loading={loading}
              size="sm"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(27, 46, 45, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.body,
    fontWeight: fontWeight.semibold,
    color: colors.ink,
  },
  message: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.secondary,
    color: colors.inkMuted,
    lineHeight: 20,
  },
  actions: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  cancel: { minHeight: 40, justifyContent: 'center', paddingHorizontal: spacing.md },
  cancelLabel: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.inkMuted,
  },
});

export default ConfirmDialog;
