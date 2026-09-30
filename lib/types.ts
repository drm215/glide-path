// Data types shared by the app screens and the sync code.

export type ThrowType = 'Drive' | 'Approach' | 'Putt';
// 'Hit basket' and 'Missed' are putt results; 'Basket' means the throw went in.
export type Lie = 'Fairway' | 'Woods' | 'Hazard' | 'OB' | 'Basket' | 'Other' | 'Hit basket' | 'Missed';
export type Disc = string;
export type DiscInfo = { id: string; name: string; brand: string; category: string; speed: string; glide: string; turn: string; fade: string; stability: string; color?: string; background_color?: string };
// altitude (meters) is the GPS elevation where the throw was logged; throws before it was recorded lack it.
export type Shot = { x: number; y: number; feet: number; disc: Disc; type: ThrowType; hole: number; courseId?: string; latitude?: number; longitude?: number; altitude?: number | null; lie?: Lie; quality?: number; qualityMax?: number };
// altitude is in meters; points saved before elevation tracking don't have it.
export type GpsPoint = { latitude: number; longitude: number; accuracy: number | null; timestamp: number; altitude?: number | null; altitudeAccuracy?: number | null };
export type HoleLayout = { tee: GpsPoint | null; basket: GpsPoint | null; par?: number };

// updatedAt (ms) is the time of the last local edit, used to resolve sync conflicts.
// Records saved before sync existed have none and count as the oldest possible edit.
export type SessionArchive = {
  id: string; mode: 'Round' | 'Practice'; courseName: string; courseId?: string; shots: Shot[];
  updatedAt?: number; shared?: boolean; shareToken?: string | null;
  // Which of the course's layouts was played; absent means the main layout.
  layoutId?: string; layoutName?: string;
};

// One way to play a course (tee pads, pin positions): its own holes, tees, baskets and pars.
export type CourseLayout = { id: string; name: string; holes: number; layouts: HoleLayout[] };

// `address` is the single-line field from before street/city/state were split; it's read as the street.
export type CourseDetails = { address?: string; street?: string; city?: string; state?: string; phone?: string; email?: string; website?: string; notes?: string };
// `holes` and `layouts` hold the course's main layout; any others are in `extraLayouts`.
export type Course = { id: string; name: string; holes: number; layouts?: HoleLayout[] } & CourseDetails & {
  layoutName?: string;
  extraLayouts?: CourseLayout[];
  updatedAt?: number;
  published?: boolean;
  // Server id, assigned on first sync; used for public course links.
  uid?: string;
  // Set on courses downloaded from the public directory.
  sourceUid?: string;
};

// A deleted course, remembered until the deletion has synced.
export type Tombstone = { clientId: string; updatedAt: number };

export type AccountUser = { id: string; email: string; displayName: string };
