import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BORDER_RADIUS, SPACING, COLORS } from '@/constants/theme';
import { statusLabel, statusColor } from '@/utils/format';
import { ThemeColors } from '@/types';

interface StatusBadgeProps {
  status: string;
  colors: ThemeColors;
}

export function StatusBadge({ status, colors }: StatusBadgeProps) {
  const label = statusLabel(status);
  const color = statusColor(status, colors);

  return (
    <View
      style={[
        styles.badge,
        {
          borderColor: color,
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          {
            color,
          },
        ]}
      >
        {label}
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
