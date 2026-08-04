/**
 * Digital signature capture component using SVG & PanResponder.
 * Works seamlessly across iOS, Android, and Web in Expo without extra native dependencies.
 * Exports signature as a PNG/SVG data URI.
 */
import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  PanResponder,
  GestureResponderEvent,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, spacing, radius, fontSize, fontWeight } from '../../constants/theme';

interface Props {
  onOK?: (signatureDataUri: string) => void;
  onClear?: () => void;
}

export function SignatureCapture({ onOK, onClear }: Props) {
  const [paths, setPaths] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt: GestureResponderEvent) => {
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentPath(`M${locationX.toFixed(1)},${locationY.toFixed(1)}`);
      },
      onPanResponderMove: (evt: GestureResponderEvent) => {
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentPath((prev) => `${prev} L${locationX.toFixed(1)},${locationY.toFixed(1)}`);
      },
      onPanResponderRelease: () => {
        if (currentPath) {
          setPaths((prev) => {
            const updated = [...prev, currentPath];
            if (onOK) {
              const svgData = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150">${updated.map(p => `<path d="${p}" stroke="${colors.ink}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>`;
              onOK(`data:image/svg+xml;base64,${btoa(svgData)}`);
            }
            return updated;
          });
          setCurrentPath('');
        }
      },
    })
  ).current;

  function handleClear() {
    setPaths([]);
    setCurrentPath('');
    if (onClear) onClear();
  }

  const allPaths = [...paths, currentPath].filter(Boolean);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Vendor Digital Signature</Text>
      <View style={styles.canvas} {...panResponder.panHandlers}>
        <Svg style={StyleSheet.absoluteFill}>
          {allPaths.map((d, index) => (
            <Path
              key={index}
              d={d}
              stroke={colors.indigoDeep}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </Svg>
        {allPaths.length === 0 ? (
          <View style={styles.placeholder} pointerEvents="none">
            <Text style={styles.placeholderText}>Sign on the line below</Text>
            <View style={styles.line} />
          </View>
        ) : null}
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={handleClear}
          accessibilityRole="button"
          style={({ pressed }) => [styles.clearBtn, pressed && styles.pressed]}
        >
          <Text style={styles.clearText}>Clear signature</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: spacing.md },
  label: {
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.indigoDeep,
    marginBottom: spacing.xs,
  },
  canvas: {
    height: 150,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    position: 'relative',
  },
  placeholder: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: spacing.lg,
  },
  placeholderText: {
    fontSize: fontSize.caption,
    color: colors.slate,
    marginBottom: spacing.xs,
  },
  line: {
    width: '80%',
    height: 1,
    backgroundColor: colors.border,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.xs,
  },
  clearBtn: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  clearText: {
    fontSize: fontSize.caption,
    color: colors.alert,
    fontWeight: fontWeight.medium,
  },
  pressed: { opacity: 0.7 },
});
