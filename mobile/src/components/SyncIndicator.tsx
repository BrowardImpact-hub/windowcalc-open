import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SPACING } from '@/constants/theme';
import { ThemeColors } from '@/types';
import { timeSince } from '@/utils/format';

interface SyncIndicatorProps {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  failedCount: number;
  lastSyncTime?: string | null;
  colors: ThemeColors;
}

export function SyncIndicator({
  isOnline,
  isSyncing,
  pendingCount,
  failedCount,
  lastSyncTime,
  colors,
}: SyncIndicatorProps) {
  let dotColor = colors.green;
  let label = 'Live';

  if (isSyncing) {
    dotColor = colors.teal;
    label = 'Syncing now';
  } else if (failedCount > 0) {
    dotColor = colors.red;
    label = `${failedCount} need${failedCount === 1 ? 's' : ''} review`;
  } else if (!isOnline) {
    dotColor = colors.textMuted;
    label = pendingCount > 0 ? `${pendingCount} waiting offline` : 'Offline';
  } else if (pendingCount > 0) {
    dotColor = colors.amber;
    label = `${pendingCount} pending`;
  }

  return (
    <View style={styles.wrapper}>
      <View style={styles.row}>
        {isSyncing ? (
          <ActivityIndicator size="small" color={colors.teal} />
        ) : (
          <View
            style={[
              styles.dot,
              {
                backgroundColor: dotColor,
              },
            ]}
          />
        )}
        <Text style={[styles.text, { color: dotColor }]}>
          {label}
        </Text>
      </View>
      <Text style={[styles.subtext, { color: colors.textMuted }]}>
        {failedCount > 0
          ? 'Open Profile for the latest sync issue and retry guidance'
          : lastSyncTime
          ? `Last sync ${timeSince(lastSyncTime)}`
          : 'No completed sync yet'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: SPACING.XS,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.SM,
  },
  dot: {
    width: SPACING.MD,
    height: SPACING.MD,
    borderRadius: SPACING.MD / 2,
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
  },
  subtext: {
    fontSize: 11,
    marginLeft: SPACING.MD + SPACING.SM,
  },
});
