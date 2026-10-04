/// <reference types="jest" />
// Stand-ins for the native modules the app uses, so screens can render and run under Jest.
// Tests reach into them through the `__store` (keychain) and `__state` (GPS position) fields.
import mockAsyncStorage from '@react-native-async-storage/async-storage/jest/async-storage-mock';

jest.mock('@react-native-async-storage/async-storage', () => mockAsyncStorage);

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { store.delete(key); }),
    __store: store,
  };
});

// A position the tests can move: logging a throw reads wherever `__position` is.
jest.mock('expo-location', () => {
  const state = { position: { latitude: 40, longitude: -75 }, accuracy: 4 as number | null };
  const fix = () => ({
    coords: { ...state.position, accuracy: state.accuracy, altitude: 100, altitudeAccuracy: 3, heading: null, speed: null },
    timestamp: Date.now(),
  });
  return {
    Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
    requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
    getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
    hasServicesEnabledAsync: jest.fn(async () => true),
    getCurrentPositionAsync: jest.fn(async () => fix()),
    watchPositionAsync: jest.fn(async () => ({ remove: jest.fn() })),
    __state: state,
  };
});

jest.mock('expo-brightness', () => ({
  getBrightnessAsync: jest.fn(async () => 0.8),
  setBrightnessAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

// Maps render as plain views; their contents aren't under test.
jest.mock('react-native-maps', () => {
  const { View } = jest.requireActual('react-native');
  const Stub = ({ children }: { children?: unknown }) => children ?? null;
  return { __esModule: true, default: View, Marker: Stub, Polyline: Stub, Circle: Stub };
});
