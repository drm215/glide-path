// Merging two saves of the same course (src/course-merge.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CourseRecord } from '../src/contract.ts';
import { mergeCourseRecords, sameCourse } from '../src/course-merge.ts';

const point = (latitude: number, timestamp: number) => ({ latitude, longitude: -75, accuracy: 4, timestamp });
const record = (updatedAt: number, overrides: Partial<CourseRecord> = {}): CourseRecord => ({
  clientId: 'c1', updatedAt, name: 'Steele Creek', holes: 1, layouts: [{ tee: null, basket: null }],
  details: {}, published: false, extraLayouts: [], ...overrides,
});

describe('mergeCourseRecords', () => {
  test('each tee and basket keeps its latest save, and the newer save names the course', () => {
    const stored = record(200, { name: 'Steele Creek Park', layouts: [{ tee: point(40, 150), basket: point(40.001, 100), par: 3 }] });
    const incoming = record(100, { layouts: [{ tee: point(40.0001, 90), basket: point(40.0011, 120), par: 4 }] });
    const merged = mergeCourseRecords(stored, incoming);
    assert.equal(merged.name, 'Steele Creek Park');
    assert.deepEqual(merged.layouts, [{ tee: point(40, 150), basket: point(40.0011, 120), par: 3 }]);
    assert.equal(merged.updatedAt, 200);
  });

  test("holes and layouts mapped on only one side are kept; another device's empty layout isn't", () => {
    const longTees = (layouts: CourseRecord['layouts']) => ({ id: 'long', name: 'Long tees', holes: layouts.length, layouts });
    const mapped = Array.from({ length: 9 }, (_, index) => ({ tee: point(41 + index, 50), basket: point(41.001 + index, 50), par: 3 }));
    // The newer save still has the long tees as one empty hole; the older one mapped all nine.
    const stored = record(300, { details: { notes: '$2 per car' }, extraLayouts: [longTees([{ tee: null, basket: null }])] });
    const incoming = record(100, { extraLayouts: [longTees(mapped), { id: 'empty', name: 'Never used', holes: 1, layouts: [{ tee: null, basket: null }] }] });
    const merged = mergeCourseRecords(stored, incoming);
    assert.equal(merged.details.notes, '$2 per car');
    assert.deepEqual(merged.extraLayouts.map((layout) => [layout.id, layout.holes]), [['long', 9]]);
    assert.deepEqual(merged.extraLayouts[0].layouts, mapped);

    const onlyOlder = mergeCourseRecords(record(300), record(100, { extraLayouts: [longTees(mapped)] }));
    assert.deepEqual(onlyOlder.extraLayouts.map((layout) => layout.id), ['long'], 'a mapped layout the newer save lacks is kept');
  });

  test('a deletion stands', () => {
    const deleted = record(300, { deleted: true });
    assert.equal(mergeCourseRecords(record(100, { layouts: [{ tee: point(40, 50), basket: null }] }), deleted), deleted);
  });

  test('sameCourse ignores edit times and field order', () => {
    const a = record(1, { details: { city: 'Bristol', state: 'TN' } });
    const b = { ...record(2), details: { state: 'TN', city: 'Bristol', notes: undefined } };
    assert.ok(sameCourse(a, b));
    assert.ok(!sameCourse(a, record(1, { name: 'Other' })));
  });
});
