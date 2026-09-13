import React, { useEffect, useMemo, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  Pressable,
  ActivityIndicator,
  Modal,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useBundleStore } from '@/store/bundleStore';
import { useDraftStore } from '@/store/draftStore';
import { useSyncStore } from '@/store/syncStore';
import { fmtMoney, fmtPct } from '@/utils/format';
import { OpeningCard } from '@/components/OpeningCard';
import { HeadroomBadge } from '@/components/HeadroomBadge';
import { api } from '@/api/endpoints';
import { Opening, PriceBounds } from '@/types';
import { buildLocalPriceBounds, calculateOpeningPricing } from '@/pricing/engine';

export default function QuoteDetailScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string | string[] }>();
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const router = useRouter();
  const { colors } = useTheme();

  const bundle = useBundleStore((state) => state.bundle);
  const pricingCompatible = useBundleStore((state) => state.pricingCompatible);
  const pricingWarning = useBundleStore((state) => state.pricingWarning);
  const cacheBundleQuotes = useDraftStore((state) => state.cacheBundleQuotes);
  const quotes = useDraftStore((state) => state.quotes);
  const batchUpdateOpenings = useDraftStore((state) => state.batchUpdateOpenings);
  const updateOpeningDraft = useDraftStore((state) => state.updateOpeningDraft);
  const { enqueueEvent, flushIfOnline, isOnline } = useSyncStore();

  const [priceBounds, setPriceBounds] = useState<PriceBounds[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [narrativeVisible, setNarrativeVisible] = useState(false);
  const [narrative, setNarrative] = useState('');
  const [narrativeLoading, setNarrativeLoading] = useState(false);

  const quote = useMemo(
    () => (id ? quotes.find((item) => item.id === id) || null : null),
    [quotes, id]
  );

  useEffect(() => {
    if (!id || !bundle?.quotes?.length) {
      return;
    }

    const bundleQuote = bundle.quotes.find((item) => item.id === id);
    if (!bundleQuote) {
      return;
    }

    cacheBundleQuotes([bundleQuote]).catch((error) => {
      console.warn('Failed to hydrate quote locally:', error);
    });
  }, [bundle, id, cacheBundleQuotes]);

  useEffect(() => {
    if (!id || !isOnline) {
      return;
    }

    api.quotes
      .getPriceBounds(id)
      .then((result) => setPriceBounds(result.openings))
      .catch((error) => {
        console.warn('Failed to load price bounds:', error);
      });
  }, [id, isOnline]);

  const governance = bundle?.governance || {
    margin_floor: 0,
    yellow_threshold: 0,
  };

  const localPriceBounds = useMemo(() => {
    if (!bundle || !quote?.openings?.length) {
      return new Map<string, PriceBounds>();
    }

    return new Map(
      quote.openings
        .map((opening) => {
          const pricing = calculateOpeningPricing(bundle, {
            productId: opening.product_id,
            width: opening.total_width,
            height: opening.total_height,
            floorLevel: opening.floor_level,
            glassOptionId: opening.glass_option_id,
            frameColorId: opening.frame_color_id,
            zipCode: quote.job_zip,
            wallType: opening.wall_type || 'cbs',
            openingCount: quote.opening_count || quote.openings?.length || 1,
            quoteTotal: quote.total_price,
            requestedSellPrice: opening.sell_price,
          });
          const bounds = buildLocalPriceBounds(opening.id, pricing);
          return bounds ? [opening.id, bounds] : null;
        })
        .filter((entry): entry is [string, PriceBounds] => Boolean(entry))
    );
  }, [bundle, quote]);

  const handlePriceCommit = async (opening: Opening, price: number) => {
    if (!quote || !bundle) {
      return;
    }

    if (!pricingCompatible) {
      Alert.alert(
        'Pricing update needed',
        pricingWarning || 'Offline pricing is out of date on this device. Refresh the bundle or update the app before editing prices.'
      );
      return;
    }

    try {
      const bounds =
        priceBounds?.find((item) => item.opening_id === opening.id) ||
        localPriceBounds.get(opening.id);
      const nextPrice = Math.max(bounds?.min_sell_price || bounds?.floor_sell_price || 0, price);
      const pricing = calculateOpeningPricing(bundle, {
        productId: opening.product_id,
        width: opening.total_width,
        height: opening.total_height,
        floorLevel: opening.floor_level,
        glassOptionId: opening.glass_option_id,
        frameColorId: opening.frame_color_id,
        zipCode: quote.job_zip,
        wallType: opening.wall_type || 'cbs',
        openingCount: quote.opening_count || quote.openings?.length || 1,
        quoteTotal: Math.max(0, quote.total_price - opening.sell_price + nextPrice),
        requestedSellPrice: nextPrice,
      });

      await updateOpeningDraft(opening.id, {
        ...opening,
        sell_price: nextPrice,
        total_cost: pricing?.total_cost ?? opening.total_cost,
        discount_pct: pricing?.discount_pct ?? opening.discount_pct,
        baseline_sell_price: pricing?.baseline_sell_price ?? opening.baseline_sell_price,
        margin_pct:
          pricing?.margin_pct ??
          (nextPrice > 0 ? ((nextPrice - opening.total_cost) / nextPrice) * 100 : 0),
        margin_dollars: pricing?.margin_dollars ?? (nextPrice - opening.total_cost),
      });

      await enqueueEvent(
        'opening_update',
        {
          opening_id: opening.id,
          quote_id: quote.id,
          opening_type: opening.opening_type,
          opening_mode: opening.opening_mode,
          total_width: opening.total_width,
          total_height: opening.total_height,
          floor_level: opening.floor_level,
          product_id: opening.product_id,
          glass_option_id: opening.glass_option_id,
          frame_color_id: opening.frame_color_id,
          sell_price: nextPrice,
          total_cost: pricing?.total_cost ?? opening.total_cost,
          discount_pct: pricing?.discount_pct ?? opening.discount_pct ?? 0,
          margin_pct:
            pricing?.margin_pct ??
            (nextPrice > 0 ? ((nextPrice - opening.total_cost) / nextPrice) * 100 : 0),
          margin_dollars: pricing?.margin_dollars ?? (nextPrice - opening.total_cost),
          dp_status: opening.dp_status,
        },
        { type: 'opening', id: opening.id }
      );

      await flushIfOnline().catch(() => {
        // Local update is already stored; sync can catch up later.
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to update price on this device.');
      console.error(error);
    }
  };

  const handleBulkAdjust = async (adjustmentPct: number) => {
    if (!quote?.openings?.length || !bundle) {
      return;
    }

    if (!pricingCompatible) {
      Alert.alert(
        'Pricing update needed',
        pricingWarning || 'Offline pricing is out of date on this device. Refresh the bundle or update the app before applying bulk changes.'
      );
      return;
    }

    setIsLoading(true);
    try {
      const nextSellPrices = quote.openings.map((opening) => {
        const bounds =
          priceBounds?.find((item) => item.opening_id === opening.id) ||
          localPriceBounds.get(opening.id);
        const baseline = bounds?.baseline_sell_price || opening.baseline_sell_price || opening.sell_price;
        const nextPrice =
          adjustmentPct === 0
            ? baseline
            : Math.max(
                bounds?.min_sell_price || bounds?.floor_sell_price || 0,
                baseline * (1 + adjustmentPct / 100)
              );
        return {
          opening,
          bounds,
          nextPrice,
        };
      });

      const projectedQuoteTotal = nextSellPrices.reduce((sum, item) => sum + item.nextPrice, 0);
      const openingUpdates = nextSellPrices.map(({ opening, nextPrice }) => {
        const pricing = calculateOpeningPricing(bundle, {
          productId: opening.product_id,
          width: opening.total_width,
          height: opening.total_height,
          floorLevel: opening.floor_level,
          glassOptionId: opening.glass_option_id,
          frameColorId: opening.frame_color_id,
          zipCode: quote.job_zip,
          wallType: opening.wall_type || 'cbs',
          openingCount: quote.opening_count || quote.openings?.length || 1,
          quoteTotal: projectedQuoteTotal,
          requestedSellPrice: nextPrice,
        });

        return {
          opening,
          nextPrice,
          pricing,
          patch: {
            ...opening,
            sell_price: nextPrice,
            total_cost: pricing?.total_cost ?? opening.total_cost,
            discount_pct: pricing?.discount_pct ?? opening.discount_pct,
            baseline_sell_price: pricing?.baseline_sell_price ?? opening.baseline_sell_price,
            margin_pct:
              pricing?.margin_pct ??
              (nextPrice > 0 ? ((nextPrice - opening.total_cost) / nextPrice) * 100 : 0),
            margin_dollars: pricing?.margin_dollars ?? (nextPrice - opening.total_cost),
          },
        };
      });

      await batchUpdateOpenings(
        openingUpdates.map((item) => ({
          openingId: item.opening.id,
          patch: item.patch,
        }))
      );

      for (const item of openingUpdates) {
        await enqueueEvent(
          'opening_update',
          {
            opening_id: item.opening.id,
            quote_id: quote.id,
            opening_type: item.opening.opening_type,
            opening_mode: item.opening.opening_mode,
            total_width: item.opening.total_width,
            total_height: item.opening.total_height,
            floor_level: item.opening.floor_level,
            product_id: item.opening.product_id,
            glass_option_id: item.opening.glass_option_id,
            frame_color_id: item.opening.frame_color_id,
            sell_price: item.nextPrice,
            total_cost: item.pricing?.total_cost ?? item.opening.total_cost,
            discount_pct: item.pricing?.discount_pct ?? item.opening.discount_pct ?? 0,
            margin_pct:
              item.pricing?.margin_pct ??
              (item.nextPrice > 0
                ? ((item.nextPrice - item.opening.total_cost) / item.nextPrice) * 100
                : 0),
            margin_dollars:
              item.pricing?.margin_dollars ?? (item.nextPrice - item.opening.total_cost),
            dp_status: item.opening.dp_status,
          },
          { type: 'opening', id: item.opening.id }
        );
      }

      await flushIfOnline().catch(() => {
        // Offline-safe bulk changes are already saved locally.
      });
    } catch (error) {
      Alert.alert('Error', 'Bulk adjust failed.');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateNarrative = async () => {
    if (!id) return;

    if (!isOnline) {
      Alert.alert('Offline', 'Narrative generation needs a live connection right now.');
      return;
    }

    setNarrativeLoading(true);
    try {
      const result = await api.quotes.generateNarrative(id);
      setNarrative(result.narrative);
      setNarrativeVisible(true);
    } catch (error) {
      Alert.alert('Error', 'Failed to generate narrative.');
      console.error(error);
    } finally {
      setNarrativeLoading(false);
    }
  };

  const handleCopyNarrative = async () => {
    try {
      await Clipboard.setStringAsync(narrative);
      Alert.alert('Copied', 'Summary copied to clipboard.');
      setNarrativeVisible(false);
    } catch (error) {
      Alert.alert('Copy failed', 'Unable to copy the summary on this device.');
    }
  };

  if (!quote) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={colors.teal} />
        </View>
      </SafeAreaView>
    );
  }

  const totalHeadroom = quote.total_price - quote.total_cost;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.customerName, { color: colors.textPrimary }]}>
              {quote.customer_name}
            </Text>
            <Text style={[styles.address, { color: colors.textMuted }]}>
              {quote.job_address}
            </Text>
            {quote.sync_state !== 'synced' ? (
              <Text style={[styles.syncLabel, { color: colors.amber }]}>
                {quote.sync_state === 'local' ? 'Saved on device only' : 'Waiting to sync'}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.headroomContainer}>
          <HeadroomBadge
            amount={totalHeadroom}
            floor={governance.margin_floor}
            yellow={governance.yellow_threshold}
            colors={colors}
          />
        </View>

        <View
          style={[
            styles.bulkAdjustBar,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
        >
          <Pressable
            onPress={() => handleBulkAdjust(-5)}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.bulkButton,
              {
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={[styles.bulkButtonText, { color: colors.red }]}>-5%</Text>
          </Pressable>
          <Pressable
            onPress={() => handleBulkAdjust(-2)}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.bulkButton,
              {
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={[styles.bulkButtonText, { color: colors.amber }]}>-2%</Text>
          </Pressable>
          <Pressable
            onPress={() => handleBulkAdjust(0)}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.bulkButton,
              {
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={[styles.bulkButtonText, { color: colors.textMuted }]}>
              Reset
            </Text>
          </Pressable>
          <Pressable
            onPress={() => handleBulkAdjust(2)}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.bulkButton,
              {
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={[styles.bulkButtonText, { color: colors.green }]}>+2%</Text>
          </Pressable>
          <Pressable
            onPress={() => handleBulkAdjust(5)}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.bulkButton,
              {
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={[styles.bulkButtonText, { color: colors.green }]}>+5%</Text>
          </Pressable>
        </View>

        <View style={styles.openingsSection}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
            Openings ({quote.opening_count})
          </Text>

          {quote.openings?.map((opening) => {
            const bounds =
              priceBounds?.find((item) => item.opening_id === opening.id) ||
              localPriceBounds.get(opening.id);
            return (
              <OpeningCard
                key={opening.id}
                opening={opening}
                priceBounds={bounds}
                onPriceCommit={(price) => handlePriceCommit(opening, price)}
                colors={colors}
              />
            );
          })}
        </View>

        <Pressable
          onPress={() =>
            router.push({
              pathname: '/(app)/add-opening/[quoteId]',
              params: { quoteId: quote.id },
            })
          }
          style={({ pressed }) => [
            styles.addOpeningButton,
            {
              backgroundColor: colors.elevated,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Text style={[styles.addOpeningText, { color: colors.textPrimary }]}>
            Add Another Opening
          </Text>
        </Pressable>

        <View
          style={[
            styles.summaryCard,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>
              Total Price
            </Text>
            <Text style={[styles.summaryValue, { color: colors.textPrimary }]}>
              {fmtMoney(quote.total_price)}
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
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>
              Total Cost
            </Text>
            <Text style={[styles.summaryValue, { color: colors.textPrimary }]}>
              {fmtMoney(quote.total_cost)}
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
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>
              Margin %
            </Text>
            <Text style={[styles.summaryValue, { color: colors.textPrimary }]}>
              {fmtPct(quote.margin_pct)}
            </Text>
          </View>
        </View>

        <View style={styles.actionButtons}>
          <Pressable
            onPress={handleGenerateNarrative}
            disabled={narrativeLoading}
            style={({ pressed }) => [
              styles.actionButton,
              {
                backgroundColor: colors.elevated,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            {narrativeLoading ? (
              <ActivityIndicator size="small" color={colors.teal} />
            ) : (
              <Text style={[styles.secondaryActionText, { color: colors.teal }]}>
                Generate Summary
              </Text>
            )}
          </Pressable>
          <Pressable
            disabled
            style={({ pressed }) => [
              styles.actionButton,
              {
                backgroundColor: colors.border,
                opacity: 0.6,
              },
            ]}
          >
            <Text style={styles.actionButtonText}>Proposal Soon</Text>
          </Pressable>
        </View>
      </ScrollView>

      <Modal
        transparent
        animationType="fade"
        visible={narrativeVisible}
        onRequestClose={() => setNarrativeVisible(false)}
      >
        <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
          <View
            style={[
              styles.narrativeModal,
              {
                backgroundColor: colors.card,
              },
            ]}
          >
            <Text style={[styles.narrativeTitle, { color: colors.textPrimary }]}>
              Quote Summary
            </Text>
            <Text
              style={[
                styles.narrativeText,
                {
                  color: colors.textMuted,
                },
              ]}
            >
              {narrative}
            </Text>

            <Pressable
              onPress={handleCopyNarrative}
              style={({ pressed }) => [
                styles.narrativeButton,
                {
                  backgroundColor: colors.teal,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Text style={styles.narrativeButtonText}>Copy and Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: SPACING.LG,
    gap: SPACING.LG,
    paddingBottom: SPACING.XXL,
  },
  header: {
    gap: SPACING.MD,
  },
  customerName: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: SPACING.SM,
  },
  address: {
    fontSize: 14,
  },
  syncLabel: {
    marginTop: SPACING.SM,
    fontSize: 12,
    fontWeight: '600',
  },
  headroomContainer: {
    alignItems: 'flex-start',
  },
  bulkAdjustBar: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'space-between',
    padding: SPACING.SM,
    gap: SPACING.SM,
  },
  bulkButton: {
    flex: 1,
    paddingVertical: SPACING.SM,
    alignItems: 'center',
  },
  bulkButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  openingsSection: {
    gap: SPACING.MD,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  addOpeningButton: {
    height: 44,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addOpeningText: {
    fontSize: 14,
    fontWeight: '700',
  },
  summaryCard: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.MD,
    gap: SPACING.SM,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.SM,
  },
  summaryLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    borderBottomWidth: 1,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: SPACING.MD,
  },
  actionButton: {
    flex: 1,
    height: 44,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  narrativeModal: {
    width: '100%',
    maxHeight: '90%',
    borderTopLeftRadius: BORDER_RADIUS.XL,
    borderTopRightRadius: BORDER_RADIUS.XL,
    padding: SPACING.LG,
    gap: SPACING.MD,
  },
  narrativeTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  narrativeText: {
    fontSize: 12,
    lineHeight: 18,
    maxHeight: 300,
  },
  narrativeButton: {
    height: 44,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.MD,
  },
  narrativeButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
