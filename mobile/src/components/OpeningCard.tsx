import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SPACING, BORDER_RADIUS, SHADOWS } from '@/constants/theme';
import { fmtMoney, openingTypeLabel, floorLabel } from '@/utils/format';
import { Opening, PriceBounds, ThemeColors } from '@/types';
import { PriceSlider } from './PriceSlider';

interface OpeningCardProps {
  opening: Opening;
  priceBounds?: PriceBounds;
  onPriceChange?: (price: number) => void;
  onPriceCommit?: (price: number) => void;
  colors: ThemeColors;
}

function getBadgeConfig(
  status: string | undefined,
  colors: ThemeColors,
  kind: 'dp' | 'noa'
): { label: string; color: string } {
  const normalized = (status || 'pending').toLowerCase();
  if (normalized === 'passed' || normalized === 'approved') {
    return {
      label: kind === 'dp' ? 'DP passed' : 'NOA ready',
      color: colors.green,
    };
  }
  if (normalized === 'failed' || normalized === 'blocked') {
    return {
      label: kind === 'dp' ? 'DP failed' : 'NOA blocked',
      color: colors.red,
    };
  }
  return {
    label: kind === 'dp' ? 'DP pending' : 'NOA pending',
    color: colors.amber,
  };
}

export function OpeningCard({
  opening,
  priceBounds,
  onPriceChange,
  onPriceCommit,
  colors,
}: OpeningCardProps) {
  const [displayPrice, setDisplayPrice] = useState(opening.sell_price);

  useEffect(() => {
    setDisplayPrice(opening.sell_price);
  }, [opening.sell_price]);

  const min =
    priceBounds?.min_sell_price ?? priceBounds?.floor_sell_price ?? opening.sell_price * 0.8;
  const max = Math.max(
    priceBounds?.suggested_sell_price ?? 0,
    priceBounds?.baseline_sell_price ?? 0,
    opening.sell_price * 1.2,
    min + 50
  );
  const dpBadge = getBadgeConfig(opening.dp_status, colors, 'dp');
  const noaBadge = getBadgeConfig(opening.noa_status, colors, 'noa');

  const handlePriceChange = (value: number) => {
    setDisplayPrice(value);
    onPriceChange?.(value);
  };

  const handlePriceCommit = (value: number) => {
    setDisplayPrice(value);
    onPriceCommit?.(value);
  };

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
        SHADOWS.SM,
      ]}
    >
      <View>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          {openingTypeLabel(opening.opening_type)}
        </Text>
        <Text style={[styles.meta, { color: colors.textMuted }]}>
          {opening.total_width}" x {opening.total_height}" | {floorLabel(opening.floor_level)}
        </Text>
      </View>

      <View style={styles.product}>
        <Text style={[styles.productName, { color: colors.textPrimary }]}>
          {opening.product_name}
        </Text>
        <Text style={[styles.productDetail, { color: colors.textMuted }]}>
          {opening.glass_name}
        </Text>
        <Text style={[styles.productDetail, { color: colors.textMuted }]}>
          {opening.frame_name}
        </Text>
      </View>

      <View
        style={[
          styles.divider,
          {
            borderColor: colors.border,
          },
        ]}
      />

      <View style={styles.statusRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Price</Text>
          <Text style={[styles.price, { color: colors.textPrimary }]}>
            {fmtMoney(displayPrice)}
          </Text>
        </View>
        <View style={styles.badges}>
          <View
            style={[
              styles.badge,
              {
                backgroundColor: `${dpBadge.color}20`,
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: dpBadge.color }]}>{dpBadge.label}</Text>
          </View>
          <View
            style={[
              styles.badge,
              {
                backgroundColor: `${noaBadge.color}20`,
              },
            ]}
          >
            <Text style={[styles.badgeText, { color: noaBadge.color }]}>{noaBadge.label}</Text>
          </View>
        </View>
      </View>

      {priceBounds ? (
        <View style={styles.sliderContainer}>
          <PriceSlider
            value={displayPrice}
            min={min}
            max={max}
            onValueChange={handlePriceChange}
            onSlidingComplete={handlePriceCommit}
            colors={colors}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.LG,
    gap: SPACING.MD,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: SPACING.SM,
  },
  meta: {
    fontSize: 13,
  },
  product: {
    gap: SPACING.SM,
  },
  productName: {
    fontSize: 14,
    fontWeight: '500',
  },
  productDetail: {
    fontSize: 13,
  },
  divider: {
    height: 1,
    borderBottomWidth: 1,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: SPACING.MD,
  },
  label: {
    fontSize: 12,
    marginBottom: SPACING.SM,
  },
  price: {
    fontSize: 18,
    fontWeight: '700',
  },
  badges: {
    gap: SPACING.SM,
    alignItems: 'flex-end',
  },
  badge: {
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS,
    borderRadius: BORDER_RADIUS.SM,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  sliderContainer: {
    marginTop: SPACING.MD,
  },
});
