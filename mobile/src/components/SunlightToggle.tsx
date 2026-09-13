import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { ThemeColors } from '@/types';

interface SunlightToggleProps {
  isFieldMode: boolean;
  onToggle: () => void;
  colors: ThemeColors;
}

export function SunlightToggle({ isFieldMode, onToggle, colors }: SunlightToggleProps) {
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: colors.card,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text style={{ fontSize: 18 }}>{isFieldMode ? '🌙' : '☀️'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: SPACING.LG * 2,
    height: SPACING.LG * 2,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
