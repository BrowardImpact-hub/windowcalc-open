import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BORDER_RADIUS, SPACING } from '@/constants/theme';
import { ThemeColors } from '@/types';

interface VerifiedBadgeProps {
  type: 'maps' | 'property';
  colors: ThemeColors;
}

export function VerifiedBadge({ type, colors }: VerifiedBadgeProps) {
  const label = type === 'maps' ? '📍 Maps' : '✓ PA Data';
  const bgColor = type === 'maps' ? colors.teal : colors.green;

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
