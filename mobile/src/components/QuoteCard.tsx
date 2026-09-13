import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { SPACING, BORDER_RADIUS, SHADOWS } from '@/constants/theme';
import { fmtMoney } from '@/utils/format';
import { Quote, ThemeColors } from '@/types';
import { StatusBadge } from './StatusBadge';
import { VerifiedBadge } from './VerifiedBadge';
import { MarginDot } from './MarginDot';

interface QuoteCardProps {
  quote: Quote;
  onPress: () => void;
  colors: ThemeColors;
  governance: { margin_floor: number; yellow_threshold: number };
}

export function QuoteCard({ quote, onPress, colors, governance }: QuoteCardProps) {
  const syncLabel =
    quote.sync_state === 'local'
      ? 'Offline draft'
      : quote.sync_state === 'pending'
      ? 'Pending sync'
      : null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.8 : 1,
        },
        SHADOWS.MD,
      ]}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.customerName, { color: colors.textPrimary }]}>
            {quote.customer_name}
          </Text>
          <Text style={[styles.address, { color: colors.textMuted }]}>
            {quote.job_address}
          </Text>
        </View>
        <View style={styles.statusContainer}>
          <StatusBadge status={quote.status} colors={colors} />
        </View>
      </View>

      <View style={styles.badges}>
        {quote.maps_verified ? <VerifiedBadge type="maps" colors={colors} /> : null}
        {quote.property_verified ? <VerifiedBadge type="property" colors={colors} /> : null}
      </View>

      <View style={styles.footer}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.meta, { color: colors.textMuted }]}>
            {quote.opening_count} opening{quote.opening_count !== 1 ? 's' : ''} | {fmtMoney(quote.total_price)}
          </Text>
          {syncLabel ? (
            <Text style={[styles.syncMeta, { color: colors.amber }]}>
              {syncLabel}
            </Text>
          ) : null}
        </View>
        <MarginDot
          marginPct={quote.margin_pct}
          floor={governance.margin_floor}
          yellow={governance.yellow_threshold}
          colors={colors}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.LG,
    gap: SPACING.MD,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: SPACING.MD,
  },
  customerName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: SPACING.SM,
  },
  address: {
    fontSize: 14,
  },
  statusContainer: {
    alignItems: 'flex-end',
  },
  badges: {
    flexDirection: 'row',
    gap: SPACING.SM,
    flexWrap: 'wrap',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACING.MD,
  },
  meta: {
    fontSize: 13,
  },
  syncMeta: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: SPACING.XS,
  },
});
