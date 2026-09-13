import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  Pressable,
  TextInput,
  Modal,
  FlatList,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useBundleStore } from '@/store/bundleStore';
import { useDraftStore } from '@/store/draftStore';
import { useSyncStore } from '@/store/syncStore';
import { openingTypeLabel, fmtMoney, fmtPct } from '@/utils/format';
import { PriceSlider } from '@/components/PriceSlider';
import { Product, GlassOption, FrameColor } from '@/types';
import { calculateOpeningPricing, normalizeWallType } from '@/pricing/engine';

type Step = 'measure' | 'product' | 'review';

const OPENING_TYPES = [
  { id: 'single_hung', label: 'Single Hung' },
  { id: 'double_hung', label: 'Double Hung' },
  { id: 'casement', label: 'Casement' },
  { id: 'sliding', label: 'Sliding' },
  { id: 'fixed', label: 'Fixed' },
];

const FLOOR_LEVELS = [
  { id: '1', label: '1st Floor' },
  { id: '2', label: '2nd Floor' },
  { id: '3', label: '3rd Floor' },
  { id: '4', label: '4th+ Floor' },
];

const WALL_TYPES = [
  { id: 'cbs', label: 'CBS' },
  { id: 'frame', label: 'Frame' },
  { id: 'concrete', label: 'Concrete / Masonry' },
];

const MIN_OPENING_DIMENSION_IN = 6;

export default function AddOpeningScreen() {
  const { quoteId: rawQuoteId } = useLocalSearchParams<{ quoteId: string | string[] }>();
  const quoteId = Array.isArray(rawQuoteId) ? rawQuoteId[0] : rawQuoteId;
  const router = useRouter();
  const { colors } = useTheme();

  const [step, setStep] = useState<Step>('measure');
  const [isLoading, setIsLoading] = useState(false);
  const [productSearchVisible, setProductSearchVisible] = useState(false);
  const [productSearchText, setProductSearchText] = useState('');

  const bundle = useBundleStore((state) => state.bundle);
  const pricingCompatible = useBundleStore((state) => state.pricingCompatible);
  const pricingWarning = useBundleStore((state) => state.pricingWarning);
  const addOpeningDraft = useDraftStore((state) => state.addOpeningDraft);
  const quotes = useDraftStore((state) => state.quotes);
  const { enqueueEvent, flushIfOnline } = useSyncStore();

  const [openingType, setOpeningType] = useState('single_hung');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [floorLevel, setFloorLevel] = useState('1');
  const [wallType, setWallType] = useState('cbs');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedGlass, setSelectedGlass] = useState<GlassOption | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<FrameColor | null>(null);
  const [computedPrice, setComputedPrice] = useState(0);
  const [priceMin, setPriceMin] = useState(0);
  const [priceMax, setPriceMax] = useState(0);
  const [sellPrice, setSellPrice] = useState(0);
  const canonicalWallType = normalizeWallType(wallType);

  const filteredProducts =
    bundle?.products.filter((product) =>
      product.name.toLowerCase().includes(productSearchText.toLowerCase())
    ) || [];

  const quote = useMemo(
    () => (quoteId ? quotes.find((item) => item.id === quoteId) || null : null),
    [quoteId, quotes]
  );

  const handleProductSelect = (product: Product) => {
    setSelectedProduct(product);
    setProductSearchVisible(false);
    setProductSearchText('');

    if (bundle?.glass_options?.length) {
      setSelectedGlass(bundle.glass_options[0]);
    }
    if (bundle?.frame_colors?.length) {
      setSelectedFrame(bundle.frame_colors[0]);
    }
  };

  const pricingPreview = useMemo(() => {
    if (!bundle || !selectedProduct || !selectedGlass || !selectedFrame) {
      return null;
    }

    const parsedWidth = parseFloat(width);
    const parsedHeight = parseFloat(height);
    if (
      !Number.isFinite(parsedWidth) ||
      !Number.isFinite(parsedHeight) ||
      parsedWidth < MIN_OPENING_DIMENSION_IN ||
      parsedHeight < MIN_OPENING_DIMENSION_IN
    ) {
      return null;
    }

    return calculateOpeningPricing(bundle, {
      productId: selectedProduct.id,
      width: parsedWidth,
      height: parsedHeight,
      floorLevel,
      glassOptionId: selectedGlass.id,
      frameColorId: selectedFrame.id,
      zipCode: quote?.job_zip,
      wallType: canonicalWallType,
      openingCount: (quote?.openings?.length || 0) + 1,
      quoteTotal: quote?.total_price || 0,
    });
  }, [
    bundle,
    selectedProduct,
    selectedGlass,
    selectedFrame,
    width,
    height,
    floorLevel,
    canonicalWallType,
    quote?.job_zip,
    quote?.openings,
    quote?.total_price,
  ]);

  useEffect(() => {
    if (!pricingPreview) {
      return;
    }

    const suggestedSell = pricingPreview.bounds.suggested_sell_price || pricingPreview.sell_price;
    const nextMax = Math.max(
      pricingPreview.baseline_sell_price * 1.25,
      suggestedSell * 1.15,
      pricingPreview.bounds.min_sell_price || 0,
      suggestedSell + 100
    );

    setComputedPrice(pricingPreview.baseline_sell_price);
    setPriceMin(pricingPreview.bounds.min_sell_price || pricingPreview.bounds.floor_sell_price);
    setPriceMax(nextMax);
    setSellPrice(suggestedSell);
  }, [pricingPreview]);

  const handleNext = () => {
    if (step === 'measure') {
      if (!width || !height) {
        Alert.alert('Required', 'Please enter width and height.');
        return;
      }
      const parsedWidth = parseFloat(width);
      const parsedHeight = parseFloat(height);
      if (
        !Number.isFinite(parsedWidth) ||
        !Number.isFinite(parsedHeight) ||
        parsedWidth < MIN_OPENING_DIMENSION_IN ||
        parsedHeight < MIN_OPENING_DIMENSION_IN
      ) {
        Alert.alert(
          'Invalid dimensions',
          `Width and height must both be at least ${MIN_OPENING_DIMENSION_IN}" to price this opening.`
        );
        return;
      }
      if (!bundle?.products?.length || !bundle?.glass_options?.length || !bundle?.frame_colors?.length) {
        Alert.alert(
          'Offline catalog unavailable',
          'This device needs a fresh product bundle before openings can be configured offline. Pull a sync while online first.'
        );
        return;
      }
      if (!pricingCompatible) {
        Alert.alert(
          'Pricing update needed',
          pricingWarning || 'Offline pricing is out of date on this device. Refresh the bundle or update the app before quoting.'
        );
        return;
      }
      setStep('product');
      return;
    }

    if (step === 'product') {
      if (!selectedProduct || !selectedGlass || !selectedFrame) {
        Alert.alert('Required', 'Please select product, glass, and frame.');
        return;
      }
      setStep('review');
    }
  };

  const handleAdd = async () => {
    if (!quoteId || !selectedProduct || !selectedGlass || !selectedFrame) {
      Alert.alert('Error', 'Missing required information.');
      return;
    }

    setIsLoading(true);
    try {
      if (!bundle || !pricingCompatible) {
        Alert.alert(
          'Pricing update needed',
          pricingWarning || 'Offline pricing is out of date on this device. Refresh the bundle or update the app before quoting.'
        );
        return;
      }

      const parsedWidth = parseFloat(width);
      const parsedHeight = parseFloat(height);
      if (
        !Number.isFinite(parsedWidth) ||
        !Number.isFinite(parsedHeight) ||
        parsedWidth < MIN_OPENING_DIMENSION_IN ||
        parsedHeight < MIN_OPENING_DIMENSION_IN
      ) {
        Alert.alert(
          'Invalid dimensions',
          `Width and height must both be at least ${MIN_OPENING_DIMENSION_IN}" to price this opening.`
        );
        return;
      }
      const pricing = calculateOpeningPricing(bundle, {
        productId: selectedProduct.id,
        width: parsedWidth,
        height: parsedHeight,
        floorLevel,
        glassOptionId: selectedGlass.id,
        frameColorId: selectedFrame.id,
        zipCode: quote?.job_zip,
        wallType: canonicalWallType,
        openingCount: (quote?.openings?.length || 0) + 1,
        quoteTotal: (quote?.total_price || 0) + sellPrice,
        requestedSellPrice: sellPrice,
      });

      if (!pricing) {
        throw new Error('Unable to calculate pricing on this device.');
      }

      const opening = await addOpeningDraft(quoteId, {
        quote_id: quoteId,
        opening_type: openingType,
        opening_mode: 'standard',
        total_width: parseFloat(width),
        total_height: parseFloat(height),
        floor_level: floorLevel,
        product_id: selectedProduct.id,
        product_name: selectedProduct.name,
        glass_option_id: selectedGlass.id,
        glass_name: selectedGlass.name,
        frame_color_id: selectedFrame.id,
        frame_name: selectedFrame.name,
        sell_price: pricing.sell_price,
        baseline_sell_price: pricing.baseline_sell_price,
        discount_pct: pricing.discount_pct,
        total_cost: pricing.total_cost,
        margin_pct: pricing.margin_pct,
        margin_dollars: pricing.margin_dollars,
        noa_status: 'pending',
        dp_status: 'pending',
        wall_type: canonicalWallType,
      });

      await enqueueEvent(
        'opening_add',
        {
          opening_id: opening.id,
          quote_id: quoteId,
          opening_type: opening.opening_type,
          opening_mode: opening.opening_mode,
          total_width: opening.total_width,
          total_height: opening.total_height,
          width: opening.total_width,
          height: opening.total_height,
          floor_level: opening.floor_level,
          wall_type: normalizeWallType(opening.wall_type),
          product_id: opening.product_id,
          glass_option_id: opening.glass_option_id,
          frame_color_id: opening.frame_color_id,
          sell_price: opening.sell_price,
          total_cost: opening.total_cost,
          discount_pct: pricing.discount_pct,
          margin_pct: opening.margin_pct,
          margin_dollars: opening.margin_dollars || opening.sell_price - opening.total_cost,
          dp_status: opening.dp_status,
        },
        { type: 'opening', id: opening.id }
      );

      await flushIfOnline().catch(() => {
        // Local draft remains authoritative until sync succeeds.
      });

      router.push({
        pathname: '/(app)/quote/[id]',
        params: { id: quoteId },
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to save opening on this device.');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.stepIndicator}>
            <View
              style={[
                styles.stepDot,
                {
                  backgroundColor:
                    step === 'measure' || step === 'product' || step === 'review'
                      ? colors.teal
                      : colors.textMuted,
                },
              ]}
            >
              <Text style={styles.stepText}>1</Text>
            </View>
            <View
              style={[
                styles.stepLine,
                {
                  backgroundColor: step === 'product' || step === 'review' ? colors.teal : colors.border,
                },
              ]}
            />
            <View
              style={[
                styles.stepDot,
                {
                  backgroundColor: step === 'product' || step === 'review' ? colors.teal : colors.textMuted,
                },
              ]}
            >
              <Text style={styles.stepText}>2</Text>
            </View>
            <View
              style={[
                styles.stepLine,
                {
                  backgroundColor: step === 'review' ? colors.teal : colors.border,
                },
              ]}
            />
            <View
              style={[
                styles.stepDot,
                {
                  backgroundColor: step === 'review' ? colors.teal : colors.textMuted,
                },
              ]}
            >
              <Text style={styles.stepText}>3</Text>
            </View>
          </View>

          {step === 'measure' ? (
            <View style={styles.stepContainer}>
              <Text style={[styles.stepTitle, { color: colors.textPrimary }]}>
                Measure the Opening
              </Text>

              <View style={styles.inputSection}>
                <Text style={[styles.label, { color: colors.textPrimary }]}>
                  Opening Type
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.typeScroll}
                >
                  {OPENING_TYPES.map((type) => (
                    <Pressable
                      key={type.id}
                      onPress={() => setOpeningType(type.id)}
                      style={({ pressed }) => [
                        styles.typeCard,
                        {
                          backgroundColor:
                            openingType === type.id ? colors.teal : colors.card,
                          borderColor: colors.border,
                          opacity: pressed ? 0.8 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.typeLabel,
                          {
                            color: openingType === type.id ? '#fff' : colors.textPrimary,
                          },
                        ]}
                      >
                        {type.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>

              <View style={styles.dimensionRow}>
                <View style={[styles.inputSection, { flex: 1 }]}>
                  <Text style={[styles.label, { color: colors.textPrimary }]}>
                    Width (in)
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        color: colors.textPrimary,
                      },
                    ]}
                    placeholder="36"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    value={width}
                    onChangeText={setWidth}
                  />
                </View>
                <View style={[styles.inputSection, { flex: 1 }]}>
                  <Text style={[styles.label, { color: colors.textPrimary }]}>
                    Height (in)
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        color: colors.textPrimary,
                      },
                    ]}
                    placeholder="48"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    value={height}
                    onChangeText={setHeight}
                  />
                </View>
              </View>

              <View style={styles.inputSection}>
                <Text style={[styles.label, { color: colors.textPrimary }]}>
                  Floor Level
                </Text>
                <View style={styles.floorRow}>
                  {FLOOR_LEVELS.map((floor) => (
                    <Pressable
                      key={floor.id}
                      onPress={() => setFloorLevel(floor.id)}
                      style={({ pressed }) => [
                        styles.floorButton,
                        {
                          backgroundColor: floorLevel === floor.id ? colors.teal : colors.card,
                          borderColor: colors.border,
                          opacity: pressed ? 0.8 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.floorButtonText,
                          {
                            color: floorLevel === floor.id ? '#fff' : colors.textPrimary,
                          },
                        ]}
                      >
                        {floor.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.inputSection}>
                <Text style={[styles.label, { color: colors.textPrimary }]}>
                  Wall Type
                </Text>
                <View style={styles.wallTypeRow}>
                  {WALL_TYPES.map((option) => (
                    <Pressable
                      key={option.id}
                      onPress={() => setWallType(option.id)}
                      style={({ pressed }) => [
                        styles.wallTypeButton,
                        {
                          backgroundColor: wallType === option.id ? colors.teal : colors.card,
                          borderColor: colors.border,
                          opacity: pressed ? 0.8 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.wallTypeButtonText,
                          {
                            color: wallType === option.id ? '#fff' : colors.textPrimary,
                          },
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>
          ) : null}

          {step === 'product' ? (
            <View style={styles.stepContainer}>
              <Text style={[styles.stepTitle, { color: colors.textPrimary }]}>
                Select Product
              </Text>

              <View style={styles.inputSection}>
                <Text style={[styles.label, { color: colors.textPrimary }]}>
                  Product
                </Text>
                <Pressable
                  onPress={() => setProductSearchVisible(true)}
                  style={({ pressed }) => [
                    styles.selectButton,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.selectButtonText, { color: colors.textPrimary }]}>
                    {selectedProduct?.name || 'Choose a product...'}
                  </Text>
                </Pressable>
              </View>

              {selectedProduct ? (
                <View style={styles.inputSection}>
                  <Text style={[styles.label, { color: colors.textPrimary }]}>
                    Glass Option
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {bundle?.glass_options.map((glass) => (
                      <Pressable
                        key={glass.id}
                        onPress={() => setSelectedGlass(glass)}
                        style={({ pressed }) => [
                          styles.optionCard,
                          {
                            backgroundColor:
                              selectedGlass?.id === glass.id ? colors.teal : colors.card,
                            opacity: pressed ? 0.8 : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.optionCardText,
                            {
                              color:
                                selectedGlass?.id === glass.id
                                  ? '#fff'
                                  : colors.textPrimary,
                            },
                          ]}
                        >
                          {glass.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              {selectedProduct ? (
                <View style={styles.inputSection}>
                  <Text style={[styles.label, { color: colors.textPrimary }]}>
                    Frame Color
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {bundle?.frame_colors.map((frame) => (
                      <Pressable
                        key={frame.id}
                        onPress={() => setSelectedFrame(frame)}
                        style={({ pressed }) => [
                          styles.optionCard,
                          {
                            backgroundColor:
                              selectedFrame?.id === frame.id ? colors.teal : colors.card,
                            opacity: pressed ? 0.8 : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.optionCardText,
                            {
                              color:
                                selectedFrame?.id === frame.id
                                  ? '#fff'
                                  : colors.textPrimary,
                            },
                          ]}
                        >
                          {frame.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              ) : null}
            </View>
          ) : null}

          {step === 'review' ? (
            <View style={styles.stepContainer}>
              <Text style={[styles.stepTitle, { color: colors.textPrimary }]}>
                Set Price
              </Text>

              <View
                style={[
                  styles.summaryBox,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text style={[styles.summaryText, { color: colors.textMuted }]}>
                  {openingTypeLabel(openingType)} | {width}" x {height}"
                </Text>
                <Text style={[styles.summaryText, { color: colors.textMuted }]}>
                  {selectedProduct?.name} | {selectedGlass?.name}
                </Text>
                <Text style={[styles.summaryText, { color: colors.textMuted }]}>
                  {selectedFrame?.name}
                </Text>
                <Text style={[styles.summaryText, { color: colors.textMuted }]}>
                  Wall type: {WALL_TYPES.find((option) => option.id === canonicalWallType)?.label || canonicalWallType}
                </Text>
              </View>

              <View style={styles.inputSection}>
                <Text style={[styles.label, { color: colors.textPrimary }]}>
                  Sell Price
                </Text>
                <PriceSlider
                  value={sellPrice}
                  min={priceMin}
                  max={priceMax}
                  onValueChange={setSellPrice}
                  onSlidingComplete={setSellPrice}
                  colors={colors}
                />
                <Text style={[styles.estimateText, { color: colors.textMuted }]}>
                  Estimated baseline {fmtMoney(computedPrice)}
                </Text>
              </View>

              {pricingPreview ? (
                <View
                  style={[
                    styles.summaryBox,
                    {
                      backgroundColor: colors.card,
                      borderColor:
                        pricingPreview.governance.margin_status === 'red'
                          ? colors.red
                          : pricingPreview.governance.margin_status === 'yellow'
                          ? colors.amber
                          : colors.green,
                    },
                  ]}
                >
                  <Text style={[styles.summaryText, { color: colors.textPrimary }]}>
                    Cost {fmtMoney(pricingPreview.total_cost)} | Margin {fmtPct(
                      sellPrice > 0
                        ? ((sellPrice - pricingPreview.total_cost) / sellPrice) * 100
                        : 0
                    )}
                  </Text>
                  <Text style={[styles.summaryText, { color: colors.textMuted }]}>
                    Floor {fmtMoney(pricingPreview.bounds.min_sell_price || pricingPreview.bounds.floor_sell_price)} | Max discount {fmtPct(pricingPreview.governance.max_discount_pct)}
                  </Text>
                  <Text
                    style={[
                      styles.summaryText,
                      {
                        color: pricingPreview.requires_approval ? colors.red : colors.green,
                      },
                    ]}
                  >
                    {pricingPreview.requires_approval
                      ? 'Below device governance. Manager approval will be required.'
                      : 'Within device governance.'}
                  </Text>
                </View>
              ) : null}

              <View style={styles.statusRow}>
                <View
                  style={[
                    styles.statusBadge,
                    {
                      backgroundColor: `${colors.amber}20`,
                    },
                  ]}
                >
                  <Text style={[styles.statusText, { color: colors.amber }]}>
                    DP Pending
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    {
                      backgroundColor: `${colors.amber}20`,
                    },
                  ]}
                >
                  <Text style={[styles.statusText, { color: colors.amber }]}>
                    NOA Pending
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          <View style={styles.buttonRow}>
            {step !== 'measure' ? (
              <Pressable
                onPress={() => {
                  if (step === 'product') setStep('measure');
                  if (step === 'review') setStep('product');
                }}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  {
                    backgroundColor: colors.elevated,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.textPrimary }]}>
                  Back
                </Text>
              </Pressable>
            ) : null}

            {step !== 'review' ? (
              <Pressable
                onPress={handleNext}
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: colors.teal,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={styles.buttonText}>Next</Text>
              </Pressable>
            ) : null}

            {step === 'review' ? (
              <Pressable
                onPress={handleAdd}
                disabled={isLoading}
                style={({ pressed }) => [
                  styles.primaryButton,
                  {
                    backgroundColor: colors.teal,
                    opacity: isLoading || !selectedProduct ? 0.6 : pressed ? 0.8 : 1,
                  },
                ]}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.buttonText}>Add to Quote</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </ScrollView>

        <Modal
          transparent
          animationType="fade"
          visible={productSearchVisible}
          onRequestClose={() => setProductSearchVisible(false)}
        >
          <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
            <View
              style={[
                styles.searchModal,
                {
                  backgroundColor: colors.card,
                },
              ]}
            >
              <TextInput
                style={[
                  styles.searchInput,
                  {
                    backgroundColor: colors.elevated,
                    borderColor: colors.border,
                    color: colors.textPrimary,
                  },
                ]}
                placeholder="Search products..."
                placeholderTextColor={colors.textMuted}
                value={productSearchText}
                onChangeText={setProductSearchText}
                autoFocus
              />

              <FlatList
                data={filteredProducts}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => handleProductSelect(item)}
                    style={({ pressed }) => [
                      styles.productItem,
                      {
                        backgroundColor: colors.elevated,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.productName, { color: colors.textPrimary }]}>
                      {item.name}
                    </Text>
                  </Pressable>
                )}
              />
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    padding: SPACING.LG,
    gap: SPACING.LG,
    paddingBottom: SPACING.HUGE,
  },
  stepIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.MD,
    marginBottom: SPACING.LG,
  },
  stepDot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  stepLine: {
    flex: 1,
    height: 2,
    maxWidth: 40,
  },
  stepContainer: {
    gap: SPACING.LG,
  },
  stepTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  inputSection: {
    gap: SPACING.SM,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    fontSize: 16,
  },
  typeScroll: {
    gap: SPACING.SM,
  },
  typeCard: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    alignItems: 'center',
    minWidth: 110,
  },
  typeLabel: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  dimensionRow: {
    flexDirection: 'row',
    gap: SPACING.MD,
  },
  floorRow: {
    flexDirection: 'row',
    gap: SPACING.SM,
  },
  wallTypeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.SM,
  },
  floorButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.SM,
    alignItems: 'center',
  },
  floorButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  wallTypeButton: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    paddingHorizontal: SPACING.MD,
    paddingVertical: SPACING.SM,
    minWidth: 88,
    alignItems: 'center',
  },
  wallTypeButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  selectButton: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
  },
  selectButtonText: {
    fontSize: 14,
  },
  optionCard: {
    borderRadius: BORDER_RADIUS.MD,
    paddingHorizontal: SPACING.MD,
    paddingVertical: SPACING.SM,
    marginRight: SPACING.SM,
    justifyContent: 'center',
  },
  optionCardText: {
    fontSize: 13,
    fontWeight: '600',
  },
  summaryBox: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    gap: SPACING.SM,
  },
  summaryText: {
    fontSize: 13,
  },
  estimateText: {
    fontSize: 12,
  },
  statusRow: {
    flexDirection: 'row',
    gap: SPACING.MD,
  },
  statusBadge: {
    flex: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.SM,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: SPACING.MD,
  },
  primaryButton: {
    flex: 1,
    height: 44,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryButton: {
    flex: 1,
    height: 44,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  searchModal: {
    height: '80%',
    borderTopLeftRadius: BORDER_RADIUS.XL,
    borderTopRightRadius: BORDER_RADIUS.XL,
    padding: SPACING.LG,
    gap: SPACING.MD,
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    fontSize: 16,
  },
  productItem: {
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    marginBottom: SPACING.SM,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  productName: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
});
