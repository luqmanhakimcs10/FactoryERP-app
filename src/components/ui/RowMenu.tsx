/**
 * The ⋮ overflow menu for a list row.
 *
 * Exists because the Super Admin's factory rows stopped being tappable: a row
 * now offers four distinct actions (view, activate/deactivate, payment history,
 * edit) and picking one of them to be "what tapping does" would hide the other
 * three behind a screen they don't belong on.
 *
 * Rendered as a bottom sheet rather than an anchored popover: anchoring needs a
 * measured position, and a sheet gives every option a full-width 48pt target,
 * which is what the rest of this app's floor-facing controls do.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

export interface RowMenuOption {
  key: string;
  label: string;
  /** Ionicons name shown at the leading edge. */
  icon?: string;
  /** Renders the label in the alert colour — for the destructive option. */
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  /** Shown as the sheet's heading, e.g. the factory name. */
  title?: string;
  options: RowMenuOption[];
  /** Accessibility label for the trigger, e.g. "Actions for Alpha Textiles". */
  accessibilityLabel: string;
}

export function RowMenu({ title, options, accessibilityLabel }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={8}
        style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
      >
        <Ionicons name="ellipsis-vertical" size={18} color={colors.inkMuted} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/* The scrim closes the sheet. It is a button for screen readers so the
            sheet is dismissable without hunting for a visible control. */}
        <Pressable
          style={styles.scrim}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={() => setOpen(false)}
        >
          {/* Swallow presses inside the sheet so choosing an option does not
              also fire the scrim's dismiss. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {options.map((o) => (
              <Pressable
                key={o.key}
                accessibilityRole="button"
                onPress={() => {
                  // Close first: several of these navigate, and leaving a modal
                  // mounted over a pushed screen strands the user behind it.
                  setOpen(false);
                  o.onPress();
                }}
                style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
              >
                {o.icon ? (
                  <Ionicons
                    name={o.icon as any}
                    size={18}
                    color={o.destructive ? colors.alert : colors.primary}
                  />
                ) : null}
                <Text style={[styles.optionLabel, o.destructive && styles.optionLabelDanger]}>
                  {o.label}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              style={({ pressed }) => [styles.cancel, pressed && styles.optionPressed]}
            >
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  triggerPressed: { backgroundColor: colors.pressed },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(27, 46, 45, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingBottom: spacing.xl,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.semibold,
    color: colors.inkMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  optionPressed: { backgroundColor: colors.pressed },
  optionLabel: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    color: colors.ink,
  },
  optionLabelDanger: { color: colors.alert },
  cancel: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  cancelLabel: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.body,
    color: colors.inkMuted,
  },
});

export default RowMenu;
