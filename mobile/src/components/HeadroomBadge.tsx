import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BORDER_RADIUS, SPACING } from '@/constants/theme';
import { fmtMoney, marginColor } from '@/utils/format';
import { ThemeColors } from '@/types';

interface HeadroomBadgeProps {
  amount: number;
  floor: number;
  yellow: number;
  colors: ThemeColors;
}

export function HeadroomBadge({ amount, floor, yellow, colors }: HeadroomBadgeProps) {
  const safeFloor = floor > 0 ? floor : 1;
  const pct = (amount / safeFloor) * 100;
  const color = marginColor(pct, floor, yellow);

  const colorMap: Record<'green' | 'amber' | 'red', string> = {
    green: colors.green,
    amber: colors.amber,
    red: colors.red,
  };

  const bgColor = colorMap[color];

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: `${bgColor}20`,
          borderColor: bgColor,
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color: bgColor,
          },
        ]}
      >
        {fmtMoney(amount)} play left
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: SPACING.MD,
    paddingVertical: SPACING.SM,
    borderRadius: BORDER_RADIUS.FULL,
    borderWidth: 1,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
});
