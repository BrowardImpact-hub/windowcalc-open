import { useEffect, useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import * as Device from 'expo-device';

type DeviceKind = 'phone' | 'tablet' | 'unknown';

function inferDeviceKind(width: number, height: number): DeviceKind {
  const shortestSide = Math.min(width, height);
  const longestSide = Math.max(width, height);
  return shortestSide >= 600 || longestSide >= 900 ? 'tablet' : 'phone';
}

export function useDeviceProfile() {
  const { width, height } = useWindowDimensions();
  const [deviceKind, setDeviceKind] = useState<DeviceKind>('unknown');

  useEffect(() => {
    let mounted = true;

    Device.getDeviceTypeAsync()
      .then((type) => {
        if (!mounted) return;
        if (type === Device.DeviceType.TABLET) {
          setDeviceKind('tablet');
          return;
        }
        if (type === Device.DeviceType.PHONE) {
          setDeviceKind('phone');
          return;
        }
        setDeviceKind('unknown');
      })
      .catch(() => {
        if (mounted) {
          setDeviceKind('unknown');
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return useMemo(() => {
    const shortestSide = Math.min(width, height);
    const longestSide = Math.max(width, height);
    const fallbackKind = inferDeviceKind(width, height);
    const resolvedKind = deviceKind === 'unknown' ? fallbackKind : deviceKind;
    const isTablet = resolvedKind === 'tablet';
    const isLargeTablet = isTablet && (shortestSide >= 768 || longestSide >= 1180);

    return {
      width,
      height,
      shortestSide,
      longestSide,
      deviceKind: resolvedKind,
      isTablet,
      isLargeTablet,
      isPhone: !isTablet,
      supportsTwoPane: isTablet && longestSide >= 1000,
    };
  }, [deviceKind, height, width]);
}
