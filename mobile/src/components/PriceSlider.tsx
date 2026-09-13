import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { fmtMoney } from '@/utils/format';
import { ThemeColors } from '@/types';

interface PriceSliderProps {
  value: number;
  min: number;
  max: number;
  onValueChange: (value: number) => void;
  onSlidingComplete: (value: number) => void;
  colors: ThemeColors;
}

export function PriceSlider({
  value,
  min,
  max,
  onValueChange,
  onSlidingComplete,
  colors,
}: PriceSliderProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const [lastHapticValue, setLastHapticValue] = useState(value);
  const [savedFlash] = useState(new Animated.Value(0));

  useEffect(() => {
    setDisplayValue(value);
  }, [value]);

  const handleValueChange = (newValue: number) => {
    setDisplayValue(newValue);
    onValueChange(newValue);

    // Haptic feedback every $100
    if (Math.floor(newValue / 100) !== Math.floor(lastHapticValue / 100)) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setLastHapticValue(newValue);
    }

    // Extra strong haptic when hitting floor
    if (Math.abs(newValue - min) < 1 && Math.abs(lastHapticValue - min) >= 1) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
  };

  const handleSlidingComplete = (finalValue: number) => {
    onSlidingComplete(finalValue);

    // Flash green "Saved" animation
    Animated.sequence([
      Animated.timing(savedFlash, {
        toValue: 1,
        duration: 200,
        useNativeDriver: false,
      }),
      Animated.timing(savedFlash, {
        toValue: 0,
        duration: 800,
        useNativeDriver: false,
      }),
    ]).start();
  };

  const isAtFloor = Math.abs(displayValue - min) < 1;
  const trackColor = isAtFloor ? colors.red : colors.teal;

  return (
    <View style={styles.container}>
      <Text
        style={[
          styles.priceDisplay,
          {
            color: colors.textPrimary,
          },
        ]}
      >
        {fmtMoney(displayValue)}
      </Text>

      <Slider
        style={styles.slider}
        minimumValue={min}
        maximumValue={max}
        step={1}
        value={displayValue}
        onValueChange={handleValueChange}
        onSlidingComplete={handleSlidingComplete}
        minimumTrackTintColor={trackColor}
        maximumTrackTintColor={colors.border}
        thumbTintColor={trackColor}
      />

      <View style={styles.labels}>
        <Text
          style={[
            styles.label,
            {
              color: colors.textMuted,
              fontFamily: 'Courier New',
            },
          ]}
        >
          {fmtMoney(min)}
        </Text>
        <Text
          style={[
            styles.label,
            {
              color: colors.textMuted,
              fontFamily: 'Courier New',
            },
          ]}
        >
          {fmtMoney(max)}
        </Text>
      </View>

      <Animated.View
        style={[
          styles.savedFlash,
          {
            opacity: savedFlash,
            backgroundColor: colors.green,
          },
        ]}
      >
        <Text style={styles.savedText}>Saved</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: SPACING.MD,
  },
  priceDisplay: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
  },
  slider: {
    height: 40,
  },
  labels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.SM,
  },
  label: {
    fontSize: 12,
    fontWeight: '500',
  },
  savedFlash: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -30,
    marginTop: -15,
    width: 60,
    height: 30,
    borderRadius: BORDER_RADIUS.LG,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  savedText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
});
