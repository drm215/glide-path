// Converts local data to and from the server's sync format (see server/README.md).
// Pure functions only, so the same code is exercised by the server's integration tests.
import type { AccountUser, Course, CourseDetails, CourseLayout, Disc, DiscInfo, HoleLayout, SessionArchive, Tombstone } from './types';

export type SyncAccount = {
  token: string;
  user: AccountUser;
  // Highest server version received; 0 downloads everything.
  cursor: number;
  // Start time of the last successful sync. Local edits after it still need uploading.
  pushedThrough: number;
  lastSyncedAt?: number;
};

export type SyncData = {
  courses: Course[];
  history: SessionArchive[];
  bag: Disc[];
  bagDetails: Record<Disc, DiscInfo>;
  bagUpdatedAt: number;
  deletedCourses: Tombstone[];
};

type CourseRecord = {
  clientId: string; updatedAt: number; deleted?: boolean; name: string; holes: number;
  layouts: HoleLayout[]; details: CourseDetails; published: boolean; uid?: string;
  layoutName?: string; extraLayouts?: CourseLayout[];
};
type RoundRecord = {
  clientId: string; updatedAt: number; deleted?: boolean; courseClientId?: string; courseName: string;
  mode: 'Round' | 'Practice'; shots: SessionArchive['shots']; shared: boolean; shareToken?: string | null; uid?: string;
  layoutId?: string;
};
type BagRecord = { updatedAt: number; discs: Disc[]; details: Record<Disc, DiscInfo> };

export type SyncRequest = { cursor: number; courses: CourseRecord[]; rounds: RoundRecord[]; bag?: BagRecord };
export type SyncResponse = { cursor: number; courses: CourseRecord[]; rounds: RoundRecord[]; bag: BagRecord | null };

// Records without an edit time predate sync; 1 makes them upload once and lose any conflict.
const editTime = (record: { updatedAt?: number }) => record.updatedAt ?? 1;

// Keeps text within the server's limits so one long field can't make the whole sync fail.
const clip = (value: string | undefined, max: number) => (value === undefined ? undefined : value.slice(0, max));

const MAX_HOLES = 100;
const MAX_EXTRA_LAYOUTS = 20;

// Exactly `holes` entries, as the server expects.
const holeLayouts = (holeCount: number, layouts: HoleLayout[] | undefined) => {
  const holes = Math.min(MAX_HOLES, Math.max(1, holeCount));
  return {
    holes,
    layouts: Array.from({ length: holes }, (_, index) => {
      const layout = layouts?.[index];
      return { tee: layout?.tee ?? null, basket: layout?.basket ?? null, ...(layout?.par === undefined ? {} : { par: layout.par }) };
    }),
  };
};

const courseToRecord = (course: Course): CourseRecord => {
  return {
    clientId: course.id,
    updatedAt: editTime(course),
    name: clip(course.name.trim() || 'Untitled course', 200)!,
    ...holeLayouts(course.holes, course.layouts),
    layoutName: clip(course.layoutName, 100),
    extraLayouts: (course.extraLayouts ?? []).slice(0, MAX_EXTRA_LAYOUTS).map((layout) => ({
      id: clip(layout.id, 100)!,
      name: clip(layout.name.trim() || 'Untitled layout', 100)!,
      ...holeLayouts(layout.holes, layout.layouts),
    })),
    details: {
      address: clip(course.address, 300),
      street: clip(course.street, 300),
      city: clip(course.city, 300),
      state: clip(course.state, 300),
      phone: clip(course.phone, 300),
      email: clip(course.email, 300),
      website: clip(course.website, 300),
      notes: clip(course.notes, 5000),
    },
    published: Boolean(course.published),
  };
};

const tombstoneToRecord = (tombstone: Tombstone): CourseRecord => ({
  clientId: tombstone.clientId,
  updatedAt: tombstone.updatedAt,
  deleted: true,
  name: 'Deleted course',
  holes: 1,
  layouts: [{ tee: null, basket: null }],
  details: {},
  published: false,
});

const roundToRecord = (session: SessionArchive): RoundRecord => ({
  clientId: session.id,
  updatedAt: editTime(session),
  courseClientId: session.courseId,
  courseName: clip(session.courseName.trim() || 'Practice area', 200)!,
  mode: session.mode,
  shots: session.shots,
  shared: Boolean(session.shared),
  layoutId: session.layoutId,
});

// A bag saved before sync existed has no edit time, so it would never upload. Stamping it
// when the app loads makes the next sync send it. An empty bag stays at 0 so a fresh
// device can't overwrite the synced bag.
export const initialBagUpdatedAt = (stored: number | undefined, bagCount: number, now: number) => stored || (bagCount ? now : 0);

// Everything edited since the last successful sync, plus every pending deletion.
export const buildSyncRequest = (data: SyncData, account: Pick<SyncAccount, 'cursor' | 'pushedThrough'>): SyncRequest => ({
  cursor: account.cursor,
  courses: [
    ...data.courses.filter((course) => editTime(course) > account.pushedThrough).map(courseToRecord),
    ...data.deletedCourses.map(tombstoneToRecord),
  ],
  rounds: data.history.filter((session) => editTime(session) > account.pushedThrough).map(roundToRecord),
  bag: data.bagUpdatedAt > account.pushedThrough ? { updatedAt: data.bagUpdatedAt, discs: data.bag, details: data.bagDetails } : undefined,
});

export const countPendingChanges = (data: SyncData, pushedThrough: number) =>
  data.courses.filter((course) => editTime(course) > pushedThrough).length
  + data.deletedCourses.length
  + data.history.filter((session) => editTime(session) > pushedThrough).length
  + (data.bagUpdatedAt > pushedThrough ? 1 : 0);

const courseFromRecord = (record: CourseRecord, local?: Course): Course => ({
  id: record.clientId,
  name: record.name,
  holes: record.holes,
  layouts: record.layouts,
  ...record.details,
  published: record.published,
  layoutName: record.layoutName || undefined,
  extraLayouts: record.extraLayouts ?? [],
  uid: record.uid,
  updatedAt: record.updatedAt,
  sourceUid: local?.sourceUid,
});

// Applies server changes to local courses: the newest edit wins, and equal edits are our
// own upload coming back, which only needs the server-assigned uid.
export const mergeCourses = (current: Course[], remote: CourseRecord[]): Course[] => {
  let next = current;
  for (const record of remote) {
    const local = next.find((course) => course.id === record.clientId);
    if (record.deleted) {
      if (local && editTime(local) <= record.updatedAt) next = next.filter((course) => course !== local);
      continue;
    }
    if (!local) {
      next = [...next, courseFromRecord(record)];
    } else if (editTime(local) < record.updatedAt) {
      next = next.map((course) => (course === local ? courseFromRecord(record, local) : course));
    } else if (editTime(local) === record.updatedAt && local.uid !== record.uid) {
      next = next.map((course) => (course === local ? { ...local, uid: record.uid } : course));
    }
  }
  return next;
};

const roundFromRecord = (record: RoundRecord): SessionArchive => ({
  id: record.clientId,
  mode: record.mode,
  courseName: record.courseName,
  courseId: record.courseClientId,
  shots: record.shots,
  shared: record.shared,
  shareToken: record.shareToken ?? null,
  updatedAt: record.updatedAt,
  layoutId: record.layoutId ?? undefined,
});

export const mergeRounds = (current: SessionArchive[], remote: RoundRecord[]): SessionArchive[] => {
  let next = current;
  for (const record of remote) {
    const local = next.find((session) => session.id === record.clientId);
    if (record.deleted) {
      if (local && editTime(local) <= record.updatedAt) next = next.filter((session) => session !== local);
      continue;
    }
    if (!local) {
      next = [...next, roundFromRecord(record)];
    } else if (editTime(local) < record.updatedAt) {
      next = next.map((session) => (session === local ? roundFromRecord(record) : session));
    } else if (editTime(local) === record.updatedAt && (local.shareToken ?? null) !== (record.shareToken ?? null)) {
      next = next.map((session) => (session === local ? { ...local, shareToken: record.shareToken ?? null } : session));
    }
  }
  return next;
};

// Deletions that were part of this upload no longer need remembering; later ones stay pending.
export const clearSentTombstones = (current: Tombstone[], sent: CourseRecord[]) =>
  current.filter((tombstone) => !sent.some((record) => record.deleted && record.clientId === tombstone.clientId && record.updatedAt === tombstone.updatedAt));
