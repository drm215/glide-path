// What the app keeps on the phone, and the helper that saves it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import type { Disc, Lie, SessionArchive, Shot, ThrowStyle, ThrowType } from '../lib/types';

// A past round reopened as the round in progress keeps its id, so ending it again updates it.
export type ResumedFrom = { id: string; shared?: boolean; shareToken?: string | null };
// A throw's details as entered in the log sheet.
export type ThrowDetails = { disc: Disc; type: ThrowType; style: ThrowStyle; lie: Lie; quality: number | null };

export type SavedRound = {
  // history is only read, from devices that saved it here before HISTORY_KEY existed.
  shots: Shot[]; hole: number; mode: 'Round' | 'Practice'; history?: SessionArchive[]; courseId?: string; active?: boolean; practiceFocus?: string;
  layoutId?: string; resumedFrom?: ResumedFrom | null;
  // A throw whose details are entered and whose location hasn't been saved yet.
  pendingThrow?: ThrowDetails | null;
  // The round's id from when it started (or the id of the round it resumed), and when its throws
  // last changed, for syncing it while it's in progress.
  activeId?: string | null; activeEditedAt?: number;
};
export type Settings = { dimRound?: boolean };
export type LastAccount = { id: string; email: string; pushedThrough: number };

// Keys keep the app's original name (Flight Notes) so existing on-device data still loads.
// The round in progress. Past sessions were once stored here too (SavedRound.history).
export const STORAGE_KEY = 'flight-notes-round-v1';
// Past sessions, kept apart from the round in progress so logging a throw doesn't rewrite them all.
export const HISTORY_KEY = 'flight-notes-history-v1';
export const COURSES_KEY = 'flight-notes-courses-v1';
export const BAG_KEY = 'flight-notes-bag-v1';
export const BAG_DETAILS_KEY = 'flight-notes-bag-details-v1';
export const BAG_WEIGHTS_KEY = 'flight-notes-bag-weights-v1';
// One-time data fixes that have already run on this device.
export const MIGRATIONS_KEY = 'flight-notes-migrations-v1';
// Sync account (without its token) and pending sync bookkeeping.
export const SYNC_KEY = 'flight-notes-sync-v1';
export const SYNC_META_KEY = 'flight-notes-sync-meta-v1';
// The account this phone's data was last synced with. Kept after signing out, so signing in to
// a different account can ask before uploading this data into it.
export const LAST_ACCOUNT_KEY = 'flight-notes-last-account-v1';
// Display preferences, such as whether the round screen dims.
export const SETTINGS_KEY = 'flight-notes-settings-v1';
// The sign-in token lives in the iOS Keychain rather than plain app storage.
export const TOKEN_KEY = 'glide-path-token';

// Keys whose stored value couldn't be read or backed up at launch. Saving to them would
// overwrite the only copy, so they're left alone until the next launch.
export const unsaveableKeys = new Set<string>();
let saveFailureShown = false;

// Writes a value to app storage, telling the user (once per launch) if storage is failing.
export const saveToStorage = (key: string, value: unknown) => {
  if (unsaveableKeys.has(key)) return;
  AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {
    if (saveFailureShown) return;
    saveFailureShown = true;
    Alert.alert('Could not save', 'Your latest changes couldn’t be saved on this phone. Free up some storage space, then reopen Glide Path.');
  });
};
