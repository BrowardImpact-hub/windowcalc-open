import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COLORS, SPACING } from '@/constants/theme';
import { marginColor } from '@/utils/format';
import { ThemeColors } from '@/types';

interface MarginDotProps {
  marginPct: number;
  floor: number;
  yellow: number;
  colors: ThemeColors;
}

export function MarginDot({ marginPct, floor, yellow, colors }: MarginDotProps) {
  const color = marginColor(marginPct, floor, yellow);

  const colorMap: Record<'green' | 'amber' | 'red', string> = {
    green: colors.green,
    amber: colors.amber,
    red: colors.red,
  };

  return (
    <View
      style={[
        styles.dot,
        {
          backgroundColor: colorMap[color],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    width: SPACING.MD,
    height: SPACING.MD,
    borderRadius: SPACING.MD / 2,
  },
});
