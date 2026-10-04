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
  // Disc weights in grams, keyed by disc name.
  bagWeights: Record<Disc, number>;
  bagUpdatedAt: number;
  deletedCourses: Tombstone[];
  deletedRounds: Tombstone[];
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
type BagRecord = { updatedAt: number; discs: Disc[]; details: Record<Disc, DiscInfo>; weights?: Record<Disc, number> };

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

const roundTombstoneToRecord = (tombstone: Tombstone): RoundRecord => ({
  clientId: tombstone.clientId,
  updatedAt: tombstone.updatedAt,
  deleted: true,
  courseName: 'Deleted round',
  mode: 'Round',
  shots: [],
  shared: false,
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

// Only weights for discs still in the bag, as whole grams the server accepts.
const bagWeightsToSend = (bag: Disc[], weights: Record<Disc, number>) =>
  Object.fromEntries(bag.flatMap((name) => {
    const grams = Math.round(weights[name] ?? 0);
    return grams >= 1 && grams <= 999 ? [[name, grams]] : [];
  }));

// Everything edited since the last successful sync, plus every pending deletion.
export const buildSyncRequest = (data: SyncData, account: Pick<SyncAccount, 'cursor' | 'pushedThrough'>): SyncRequest => ({
  cursor: account.cursor,
  courses: [
    ...data.courses.filter((course) => editTime(course) > account.pushedThrough).map(courseToRecord),
    ...data.deletedCourses.map(tombstoneToRecord),
  ],
  rounds: [
    ...data.history.filter((session) => editTime(session) > account.pushedThrough).map(roundToRecord),
    ...data.deletedRounds.map(roundTombstoneToRecord),
  ],
  bag: data.bagUpdatedAt > account.pushedThrough
    ? { updatedAt: data.bagUpdatedAt, discs: data.bag, details: data.bagDetails, weights: bagWeightsToSend(data.bag, data.bagWeights) }
    : undefined,
});

export const countPendingChanges = (data: SyncData, pushedThrough: number) =>
  data.courses.filter((course) => editTime(course) > pushedThrough).length
  + data.deletedCourses.length
  + data.deletedRounds.length
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
export const clearSentTombstones = (current: Tombstone[], sent: { clientId: string; updatedAt: number; deleted?: boolean }[]) =>
  current.filter((tombstone) => !sent.some((record) => record.deleted && record.clientId === tombstone.clientId && record.updatedAt === tombstone.updatedAt));

// The server accepts up to 5 MB, 500 courses and 2,000 rounds per request. Sending everything at
// once would fail on every retry for a large history, so uploads go in batches well under that.
const BATCH_MAX_BYTES = 1_000_000;
const BATCH_MAX_RECORDS = 100;

// Splits a request into batches by record count and size. The bag goes in the first batch. There's
// always at least one batch, since an empty upload still downloads changes.
export const splitSyncRequest = (request: SyncRequest): SyncRequest[] => {
  const batches: SyncRequest[] = [];
  let batch: SyncRequest = { cursor: request.cursor, courses: [], rounds: [], bag: request.bag };
  let bytes = request.bag ? JSON.stringify(request.bag).length : 0;
  const makeRoom = (size: number) => {
    const count = batch.courses.length + batch.rounds.length;
    if (count && (count >= BATCH_MAX_RECORDS || bytes + size > BATCH_MAX_BYTES)) {
      batches.push(batch);
      batch = { cursor: request.cursor, courses: [], rounds: [] };
      bytes = 0;
    }
    bytes += size;
  };
  for (const course of request.courses) {
    makeRoom(JSON.stringify(course).length);
    batch.courses.push(course);
  }
  for (const round of request.rounds) {
    makeRoom(JSON.stringify(round).length);
    batch.rounds.push(round);
  }
  batches.push(batch);
  return batches;
};

// Sends a request batch by batch, each with the cursor the previous one returned. `apply` merges
// each response as it arrives, so if a later batch fails, the earlier ones' progress is kept and
// they're simply sent again next time. Returns the final cursor.
export const sendInBatches = async (
  request: SyncRequest,
  send: (batch: SyncRequest) => Promise<SyncResponse>,
  apply: (batch: SyncRequest, result: SyncResponse) => void,
) => {
  let cursor = request.cursor;
  for (const batch of splitSyncRequest(request)) {
    const result = await send({ ...batch, cursor });
    apply(batch, result);
    cursor = result.cursor;
  }
  return cursor;
};
