/**
 * The signature "stitch line" — a dashed, evenly-spaced rule derived from a row
 * of embroidery stitches. Used as a section divider and structural device.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors } from '../../constants/theme';

interface Props {
  color?: string;
  height?: number;
}

export function StitchLine({ color = colors.primary, height = 2 }: Props) {
  // Render a row of short dashes to read like a stitch line.
  return (
    <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: 60 }).map((_, i) => (
        <View
          key={i}
          style={[styles.dash, { backgroundColor: color, height }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    overflow: 'hidden',
    alignItems: 'center',
  },
  dash: {
    width: 6,
    marginRight: 4,
    borderRadius: 1,
  },
});
