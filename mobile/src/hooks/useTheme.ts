import { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DARK_THEME, FIELD_MODE_THEME } from '@/constants/theme';
import { ThemeColors } from '@/types';

const THEME_MODE_KEY = 'wc_field_mode';

export function useTheme() {
  const [isFieldMode, setIsFieldModeState] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Load theme mode from AsyncStorage on mount
    AsyncStorage.getItem(THEME_MODE_KEY)
      .then((value) => {
        if (value !== null) {
          setIsFieldModeState(value === 'true');
        }
        setIsLoading(false);
      })
      .catch((e) => {
        console.warn('Failed to load theme mode:', e);
        setIsLoading(false);
      });
  }, []);

  const toggle = async () => {
    const newMode = !isFieldMode;
    setIsFieldModeState(newMode);
    try {
      await AsyncStorage.setItem(THEME_MODE_KEY, String(newMode));
    } catch (e) {
      console.warn('Failed to save theme mode:', e);
    }
  };

  const colors: ThemeColors = isFieldMode ? FIELD_MODE_THEME : DARK_THEME;

  return {
    colors,
    isFieldMode,
    toggle,
    isLoading,
  };
}
