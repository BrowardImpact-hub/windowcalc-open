# WindowCalc Mobile - Setup Guide

## Project Overview

WindowCalc Mobile is a production-quality React Native field app for impact window & door sales reps. It provides offline-first functionality, real-time synchronization, and a professional interface matching the WindowCalc web design language.

## Prerequisites

- Node.js 18+ and npm/yarn
- Expo CLI (`npm install -g expo-cli`)
- iOS Simulator (macOS) or Android Emulator
- Xcode (for iOS) or Android Studio (for Android)

## Installation

1. Install dependencies:
```bash
npm install
```

2. Copy environment configuration:
```bash
cp .env.example .env
```

3. Update `.env` with your backend URL:
```
EXPO_PUBLIC_API_BASE_URL=https://your-windowcalc-backend.run.app
```

## Development

### Start the development server:
```bash
npm start
```

### Run on iOS Simulator:
```bash
npm run ios
```

### Run on Android Emulator:
```bash
npm run android
```

## Project Structure

```
windowcalc-mobile/
├── app/                           # Expo Router app structure
│   ├── _layout.tsx               # Root layout with auth/sync initialization
│   ├── index.tsx                 # Redirect to login
│   ├── (auth)/
│   │   ├── _layout.tsx
│   │   └── login.tsx             # Login screen with biometrics
│   └── (app)/                    # Authenticated app tabs
│       ├── _layout.tsx           # Bottom tab navigator
│       ├── index.tsx             # Quotes list (home screen)
│       ├── profile.tsx           # User profile & settings
│       ├── new-quote.tsx         # Create new quote wizard
│       ├── quote/[id].tsx        # Quote detail with price sliders
│       └── add-opening/[quoteId].tsx  # 3-step opening builder
├── src/
│   ├── api/
│   │   ├── client.ts            # Authenticated fetch wrapper
│   │   └── endpoints.ts         # Typed API endpoint calls
│   ├── components/              # Reusable UI components
│   │   ├── QuoteCard.tsx
│   │   ├── OpeningCard.tsx
│   │   ├── PriceSlider.tsx      # Core UX feature with haptics
│   │   ├── MarginDot.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── VerifiedBadge.tsx
│   │   ├── HeadroomBadge.tsx
│   │   ├── SyncIndicator.tsx
│   │   └── SunlightToggle.tsx
│   ├── constants/
│   │   ├── theme.ts             # Design tokens
│   │   └── api.ts               # API configuration
│   ├── hooks/
│   │   └── useTheme.ts          # Theme context hook
│   ├── store/
│   │   ├── authStore.ts         # Authentication state
│   │   ├── bundleStore.ts       # Offline data cache
│   │   └── syncStore.ts         # Offline event queue + SQLite
│   ├── types/
│   │   └── index.ts             # TypeScript interfaces
│   └── utils/
│       ├── format.ts            # Formatting helpers
│       └── uuid.ts              # UUID generation
├── package.json
├── app.json                      # Expo configuration
├── tsconfig.json                 # TypeScript config
└── babel.config.js              # Babel plugins
```

## Key Features

### Authentication
- Email/password login with secure token storage
- Biometric (Face ID/Touch ID) support
- Automatic session expiry detection
- Device identification for audit trails

### Offline-First Architecture
- **Bundle Cache**: Stores 15-minute fresh copy of quotes, products, colors, glass options
- **Sync Queue**: SQLite-backed event queue stores user actions offline
- **Auto-Flush**: Automatically syncs pending events when connectivity returns
- **Network Detection**: Real-time connectivity monitoring via expo-network

### Data Synchronization
- All writes enqueued immediately to SQLite (optimistic offline)
- POST to `/api/mobile/sync/events` with batch of up to 50 events
- 3 retry attempts with exponential backoff
- Never loses data - stays in SQLite until server confirms

### Pricing & Calculations
- **Price Slider**: RN Slider with real-time haptic feedback
- Floor/ceiling bounds from server
- $100 haptic tick, strong feedback when at floor
- "Saved" flash animation on commit
- Bulk adjust (+/- 5%, 2%, or reset)

### Theme System
- **Dark Mode** (default): Matches web app exactly
  - Background: `#0f172a`
  - Teal primary: `#14B8A6`
  - Cards: `#1e293b`
- **Field Mode** (sunlight): High-contrast white for outdoor use
  - Background: white
  - Darker teal: `#0d9488`
  - Visible borders
- Instant toggle, persisted in AsyncStorage

### User Experience
- Pull-to-refresh on quotes list
- Animated error messages
- Loading states throughout
- Empty states with actionable prompts
- Responsive layout safe areas

## API Contract

The app expects these endpoints on the Flask backend:

### Authentication
- `POST /api/mobile/sessions` → `{ token, expires_at, user }`

### Bundle
- `GET /api/mobile/bundle/{repId}` → `MobileBundle`

### Quotes
- `GET /api/quotes/{id}` → `Quote`
- `GET /api/quotes/{id}/price-bounds` → `PriceBounds[]`
- `POST /api/quotes/{id}/bulk-adjust` → `{ total_price, openings[] }`
- `POST /api/quotes/{id}/generate-narrative` → `{ narrative }`

### Openings
- `POST /api/openings` → `Opening`
- `PATCH /api/openings/{id}` → `Opening`

### Sync
- `POST /api/mobile/sync/events` → `{ processed, failed }`

All endpoints require `Authorization: Bearer <token>` header.

## Building for Production

### iOS
```bash
npm run build:ios
```

Requires:
- Apple Developer account
- Code signing certificate
- EAS CLI configured

### Android
```bash
npm run build:android
```

Requires:
- Google Play Developer account
- Keystore file
- EAS CLI configured

### Configure EAS
```bash
eas init
eas update:configure
```

## Customization

### Theme Colors
Edit `src/constants/theme.ts`:
```typescript
export const COLORS = {
  TEAL: '#14B8A6',
  // ... modify any color
};
```

### API Base URL
Edit `.env`:
```
EXPO_PUBLIC_API_BASE_URL=https://your-url.run.app
```

### App Metadata
Edit `app.json`:
- Bundle identifiers (iOS/Android)
- App name, version
- Icons, splash screen
- Plugins

## Troubleshooting

### Build fails with "module not found"
- Run `npm install`
- Clear cache: `expo start -c`

### Blank screen on launch
- Check `app/_layout.tsx` - auth/sync initialization may be hanging
- Check network connectivity for bundle fetch
- Verify `.env` is correct

### Haptics not working
- On iOS Simulator: Haptics unavailable, works on device
- On Android: May require specific device support

### Sync events not flushing
- Check network connectivity indicator
- Verify backend is reachable at `EXPO_PUBLIC_API_BASE_URL`
- Check browser DevTools Network tab for CORS/auth issues

### Database errors
- SQLite database at `windowcalc.db` may be corrupted
- Clear app data or delete database file to reset

## Testing

The app uses no external test framework - it's designed for manual testing during development. Key test paths:

1. **Login Flow**: Test email/password and biometric login
2. **Offline**: Disable network, create quote/opening, verify sync queue fills
3. **Pricing**: Test slider, bulk adjust, haptics
4. **Theme**: Toggle sunlight mode, verify colors update instantly
5. **Refresh**: Pull-to-refresh on quotes list

## Performance Notes

- Bundle cache: 15 min TTL, loaded on app launch
- Sync queue: Batches up to 50 events per request
- Price slider: 60fps animations, haptic on every $100
- Network listener: Lightweight event subscriptions

## Dependencies

- **expo**: Framework
- **expo-router**: Navigation
- **zustand**: State management
- **@react-native-async-storage**: Local persistence
- **expo-sqlite**: Offline queue storage
- **expo-secure-store**: Token encryption
- **expo-local-authentication**: Biometrics
- **expo-haptics**: Haptic feedback
- **expo-network**: Connectivity detection
- **@react-native-community/slider**: Price slider widget

## License

Copyright WindowCalc. All rights reserved.
