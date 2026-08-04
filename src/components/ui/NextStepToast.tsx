/**
 * "What's next" guidance — one banner, every hand-off moment.
 *
 * The order lifecycle spans five roles and a dozen screens, and each step's
 * next action often lives somewhere the user isn't currently looking (assign a
 * machine here, start production there, track repeats in a third place). This
 * renders a single app-level banner saying what just happened and where to go
 * next, so a completed action never leaves the user guessing.
 *
 * Mounted once, above the navigator, so a message survives the navigation that
 * usually follows the action that raised it.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Platform, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, fontSize, fontWeight, elevation } from '../../constants/theme';

export interface NextStep {
  /** What just happened — one sentence, past tense. */
  done: string;
  /** Where to go now — one sentence, imperative. */
  next: string;
}

/**
 * Every guidance message in one place, so the wording stays consistent and a
 * step's copy can be corrected without hunting through screens.
 */
export const NEXT_STEP = {
  jobCardCreated: {
    done: 'Job card created.',
    next: 'Next: mark the client informed.',
  },
  clientInformed: {
    done: 'Client informed — job card confirmed.',
    next: 'Next: ask for material.',
  },
  materialRequested: {
    done: 'Material requested from the Store Manager.',
    next: "You'll be notified when it's ready to accept.",
  },
  inventoryAccepted: {
    done: 'Inventory accepted.',
    next: 'Next: assign a machine to begin production.',
  },
  machineAssigned: {
    done: 'Machine assigned.',
    next: 'Next: press Start Production below to begin.',
  },
  productionStarted: {
    done: 'Production started.',
    next: 'Track progress in Repeats & Stage Tracking.',
  },
  repeatStagesComplete: {
    done: 'All stages complete for this repeat.',
    next: 'It now sits in Final QA, ahead of delivery.',
  },
} as const satisfies Record<string, NextStep>;

const VISIBLE_MS = 7000;

const NextStepContext = createContext<(step: NextStep) => void>(() => {});

/** Raise the guidance banner. Safe to call from any screen. */
export function useNextStep(): (step: NextStep) => void {
  return useContext(NextStepContext);
}

export function NextStepProvider({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState<NextStep | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const offset = useRef(new Animated.Value(-16)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
      Animated.timing(offset, { toValue: -16, duration: 160, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setStep(null);
    });
  }, [opacity, offset]);

  const show = useCallback(
    (next: NextStep) => {
      if (timer.current) clearTimeout(timer.current);
      setStep(next);
      opacity.setValue(0);
      offset.setValue(-16);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.timing(offset, { toValue: 0, duration: 220, useNativeDriver: true }),
      ]).start();
      timer.current = setTimeout(dismiss, VISIBLE_MS);
    },
    [opacity, offset, dismiss]
  );

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <NextStepContext.Provider value={show}>
      {children}
      {step ? <Banner step={step} opacity={opacity} offset={offset} onDismiss={dismiss} /> : null}
    </NextStepContext.Provider>
  );
}

function Banner({
  step,
  opacity,
  offset,
  onDismiss,
}: {
  step: NextStep;
  opacity: Animated.Value;
  offset: Animated.Value;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.layer, { top: insets.top + spacing.sm }]} pointerEvents="box-none">
      <Animated.View style={[styles.card, { opacity, transform: [{ translateY: offset }] }]}>
        <Ionicons name="checkmark-circle" size={20} color={colors.success} style={styles.icon} />
        <View style={styles.copy}>
          <Text style={styles.done}>{step.done}</Text>
          <Text style={styles.next}>{step.next}</Text>
        </View>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={10}
          style={styles.close}
        >
          <Ionicons name="close" size={18} color={colors.slate} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * The same banner, placed inline in a screen instead of floating over it.
 *
 * Used where the guidance must be visible together with the control it points
 * at — most importantly after machine assignment, where the floating toast
 * would sit behind an iOS native-stack modal and the whole point is that the
 * message and the Start Production button appear together.
 */
export function NextStepBanner({ step, style }: { step: NextStep; style?: ViewStyle }) {
  return (
    <View style={[styles.card, style]}>
      <Ionicons name="checkmark-circle" size={20} color={colors.success} style={styles.icon} />
      <View style={styles.copy}>
        <Text style={styles.done}>{step.done}</Text>
        <Text style={styles.next}>{step.next}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    // Above the navigator's headers and any modal presented under it.
    zIndex: 1000,
    ...Platform.select({ android: { elevation: 24 }, default: {} }),
  },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    width: '100%',
    maxWidth: 560,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.success,
    backgroundColor: colors.tintTeal,
    ...elevation.lg,
  },
  icon: { marginTop: 1 },
  copy: { flex: 1, gap: 2 },
  done: { fontSize: fontSize.secondary, fontWeight: fontWeight.semibold, color: colors.indigoDeep },
  next: { fontSize: fontSize.caption, color: colors.slate, lineHeight: 18 },
  close: { padding: 2 },
});
