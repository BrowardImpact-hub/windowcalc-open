import { ThemeColors } from '@/types';

export const COLORS = {
  TEAL: '#14B8A6',
  TEAL_DARK: '#0d9488',
  BACKGROUND_DARK: '#0f172a',
  CARD: '#1e293b',
  ELEVATED: '#263245',
  BORDER: 'rgba(148,163,184,0.12)',
  TEXT_PRIMARY: '#f1f5f9',
  TEXT_MUTED: '#94a3b8',
  GREEN: '#10b981',
  RED: '#ef4444',
  AMBER: '#f59e0b',
  WHITE: '#ffffff',
  BLACK: '#0f172a',
  GRAY_50: '#f8fafc',
  GRAY_100: '#f1f5f9',
  GRAY_200: '#e2e8f0',
  GRAY_300: '#cbd5e1',
  GRAY_400: '#94a3b8',
  GRAY_500: '#64748b',
  GRAY_600: '#475569',
  GRAY_700: '#334155',
  GRAY_800: '#1e293b',
  GRAY_900: '#0f172a',
};

export const SPACING = {
  XS: 4,
  SM: 8,
  MD: 12,
  LG: 16,
  XL: 20,
  XXL: 24,
  XXXL: 32,
  HUGE: 48,
};

export const BORDER_RADIUS = {
  SM: 4,
  MD: 8,
  LG: 12,
  XL: 16,
  FULL: 9999,
};

export const SHADOWS = {
  NONE: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  SM: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  MD: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  LG: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
};

export const DARK_THEME: ThemeColors = {
  primary: COLORS.TEAL,
  background: COLORS.BACKGROUND_DARK,
  card: COLORS.CARD,
  elevated: COLORS.ELEVATED,
  border: COLORS.BORDER,
  textPrimary: COLORS.TEXT_PRIMARY,
  textMuted: COLORS.TEXT_MUTED,
  green: COLORS.GREEN,
  red: COLORS.RED,
  amber: COLORS.AMBER,
  teal: COLORS.TEAL,
};

export const FIELD_MODE_THEME: ThemeColors = {
  primary: COLORS.TEAL_DARK,
  background: COLORS.WHITE,
  card: COLORS.GRAY_50,
  elevated: COLORS.GRAY_100,
  border: COLORS.GRAY_300,
  textPrimary: COLORS.BLACK,
  textMuted: COLORS.GRAY_600,
  green: COLORS.GREEN,
  red: COLORS.RED,
  amber: COLORS.AMBER,
  teal: COLORS.TEAL_DARK,
};

export const FIELD_MODE_COLORS = {
  DARK: DARK_THEME,
  LIGHT: FIELD_MODE_THEME,
};
