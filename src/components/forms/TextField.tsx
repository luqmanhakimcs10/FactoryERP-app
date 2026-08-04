/** Labelled text input with error state. Handles text / textarea / number. */
import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import {
  colors,
  spacing,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
} from '../../constants/theme';

interface Props {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
  multiline?: boolean;
  numeric?: boolean;
  mono?: boolean;
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  required,
  error,
  multiline,
  numeric,
  mono,
}: Props) {
  // Focus is tracked only to draw the teal ring — it changes nothing about
  // validation or what the field reports back.
  const [focused, setFocused] = React.useState(false);

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.req}> *</Text> : null}
      </Text>
      <TextInput
        style={[
          styles.input,
          multiline && styles.multiline,
          mono && { fontFamily: fontFamily.mono },
          focused && styles.inputFocused,
          !!error && styles.inputError,
        ]}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.inkSubtle}
        multiline={multiline}
        numberOfLines={multiline ? 3 : 1}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        autoCapitalize={numeric ? 'none' : 'sentences'}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: {
    fontFamily: fontFamily.sansMedium,
    fontSize: fontSize.secondary,
    fontWeight: fontWeight.medium,
    color: colors.ink,
    marginBottom: spacing.xs,
  },
  req: { color: colors.accent },
  input: {
    minHeight: 48,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  inputFocused: { borderColor: colors.primary },
  inputError: { borderColor: colors.accent },
  error: {
    fontFamily: fontFamily.sans,
    marginTop: spacing.xs,
    fontSize: fontSize.caption,
    color: colors.accent,
  },
});
