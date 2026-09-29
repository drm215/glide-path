import { z } from 'zod';

// Shapes the app sends and receives. Field names follow the app's own types.

const gpsPoint = z.looseObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nullable().optional(),
  timestamp: z.number().optional(),
  altitude: z.number().nullable().optional(),
  altitudeAccuracy: z.number().nullable().optional(),
});

const holeLayout = z.object({
  tee: gpsPoint.nullable(),
  basket: gpsPoint.nullable(),
  par: z.number().int().min(1).max(10).optional(),
});

const shortText = z.string().max(300).optional();

export const courseDetails = z.object({
  address: shortText,
  street: shortText,
  city: shortText,
  state: shortText,
  phone: shortText,
  email: shortText,
  website: shortText,
  notes: z.string().max(5000).optional(),
});

const syncMeta = {
  clientId: z.string().min(1).max(100),
  updatedAt: z.number().int().nonnegative(),
  deleted: z.boolean().optional(),
};

// Extra ways to play the course; the main layout is the course's own holes/layouts.
const extraLayout = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  holes: z.number().int().min(1).max(100),
  layouts: z.array(holeLayout).max(100),
});

export const courseRecord = z.object({
  ...syncMeta,
  name: z.string().min(1).max(200),
  holes: z.number().int().min(1).max(100),
  layouts: z.array(holeLayout).max(100),
  layoutName: z.string().max(100).optional(),
  extraLayouts: z.array(extraLayout).max(20).default([]),
  details: courseDetails.default({}),
  published: z.boolean().default(false),
});

const shot = z.looseObject({
  hole: z.number().int().min(1).max(100),
  feet: z.number(),
  disc: z.string().max(200),
  type: z.string().max(50),
});

export const roundRecord = z.object({
  ...syncMeta,
  courseClientId: z.string().max(100).optional(),
  courseName: z.string().min(1).max(200),
  mode: z.enum(['Round', 'Practice']),
  layoutId: z.string().max(100).optional(),
  shots: z.array(shot).max(3000),
  shared: z.boolean().default(false),
});

export const bagRecord = z.object({
  updatedAt: z.number().int().nonnegative(),
  discs: z.array(z.string().max(200)).max(200),
  details: z.record(z.string(), z.looseObject({})).default({}),
});

export const syncRequest = z.object({
  // The highest version the client has seen; 0 downloads everything.
  cursor: z.number().int().nonnegative().default(0),
  courses: z.array(courseRecord).max(500).default([]),
  rounds: z.array(roundRecord).max(2000).default([]),
  bag: bagRecord.optional(),
});

export const registerRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(60),
});

export const loginRequest = z.object({
  email: z.string().max(254),
  password: z.string().max(200),
});

export type CourseRecord = z.infer<typeof courseRecord>;
export type RoundRecord = z.infer<typeof roundRecord>;
export type BagRecord = z.infer<typeof bagRecord>;
