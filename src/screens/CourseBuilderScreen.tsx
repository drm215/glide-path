import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { courseShareUrl } from '../../lib/api';
import { duplicatesOf } from '../../lib/course-combine';
import { canEditCourse } from '../../lib/public-course';
import { MAIN_LAYOUT_ID, courseLayouts } from '../../lib/layouts';
import type { Course } from '../../lib/types';
import { styles } from '../theme';
import { PAR_OPTIONS } from '../constants';
import { formatElevation } from '../format';
import { courseStats, holeDistanceFeet, holeElevationFeet } from '../geo';
import { ScreenHeading } from '../components/ScreenHeading';
import { CourseDetailsFields } from '../components/CourseDetailsFields';
import { CourseEditors } from '../components/CourseEditors';
import { LayoutsEditor } from '../components/LayoutsEditor';
import { shareLink } from '../links';
import { useApp } from '../state/AppState';

export const CourseBuilderScreen = () => {
  const { addHoleToCourse, combineCourse, courses, deleteCourse, deleteHole, hasMultipleLayouts, mapLayout, selectedBaseCourse, selectedCourse, selectedCourseId, setHolePar, setSelectedCourseId, setSelectedLayoutId, startNewCourse } = useApp();
  // The courses this account can change: ones it created, or is an owner or admin of.
  const editable = courses.filter(canEditCourse);
  const editing = selectedBaseCourse && canEditCourse(selectedBaseCourse) ? selectedBaseCourse : undefined;
  // Two courses that are really the same one: this one's holes, layouts and rounds go into the
  // other, and this one is deleted.
  const confirmCombine = (source: Course, target: Course) => Alert.alert(
    `Combine into the other ${target.name}?`,
    `Its holes and layouts are added to ${target.createdBy ? `the one ${target.createdBy} created` : 'your other one'} (where both have a tee or basket, the more recently saved one is kept), its rounds move there, and this one is deleted for everyone.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Combine', onPress: () => combineCourse(source, target) }],
  );
  const selectedCourseStats = selectedCourse ? courseStats(selectedCourse) : null;

  const mappedHoleCount = selectedCourse?.layouts?.filter((layout) => layout.tee && layout.basket).length ?? 0;

  return <>
    <ScreenHeading eyebrow="COURSES YOU CAN EDIT" title="Course builder." />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable onPress={startNewCourse} style={[styles.primaryButton, styles.newCourseButton]} accessibilityRole="button"><Text style={styles.primaryButtonText}>+ NEW COURSE</Text></Pressable>
      <Text style={styles.builderHint}>Every course is public: anyone can find and play it. Name it, add its details and layouts, then map each layout’s holes.</Text>
      <Text style={styles.builderSectionTitle}>Courses you can edit</Text>
      {!editable.length && <Text style={styles.mapInstruction}>None yet. Create one, or ask an owner of a course to make you an admin.</Text>}
      {editable.map((course) => <View key={course.id} style={[styles.courseItem, selectedCourseId === course.id && styles.courseItemSelected]}><Pressable onPress={() => { if (course.id !== selectedCourseId) setSelectedLayoutId(MAIN_LAYOUT_ID); setSelectedCourseId(course.id); }} style={styles.courseItemSelect}><View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{course.name}</Text><Text style={styles.courseItemMeta}>{courseLayouts(course).length > 1 ? `${courseLayouts(course).length} layouts` : `${course.holes} holes`} · {selectedCourseId === course.id ? 'Selected' : 'Tap to select'}</Text></View><Text style={styles.courseSelectedMark}>{selectedCourseId === course.id ? '✓' : '○'}</Text></Pressable><Pressable onPress={() => deleteCourse(course)} accessibilityRole="button" accessibilityLabel={`Delete ${course.name}`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable></View>)}
      {editing && selectedCourse && <View style={styles.mapEditor}>
        <LayoutsEditor base={editing} view={selectedCourse} />
      </View>}
      {editing && selectedCourse && <View style={styles.mapEditor}>
        <Text style={styles.builderSectionTitle}>Course details</Text>
        {editing.createdBy ? <Text style={[styles.courseItemMeta, styles.sourceNote]}>Created by {editing.createdBy}. You’re {editing.role === 'owner' ? 'an owner' : 'an admin'}.</Text> : null}
        <CourseEditors course={editing} />
        {duplicatesOf(editing, courses).map((other) => <Pressable key={other.id} onPress={() => confirmCombine(editing, other)} style={[styles.courseLink, styles.combineButton]} accessibilityRole="button" accessibilityLabel={`Combine into the other ${other.name}`}>
          <Text style={styles.courseLinkText}>COMBINE INTO {other.createdBy ? `THE ONE ${other.createdBy.toUpperCase()} CREATED` : `YOUR OTHER ${other.name.toUpperCase()}`}</Text>
        </Pressable>)}
        {selectedCourse.uid ? <Pressable onPress={() => shareLink(`${selectedCourse.name} on Glide Path:`, courseShareUrl(selectedCourse.uid!))} style={[styles.courseLink, styles.toggleAction]}><Text style={styles.courseLinkText}>SHARE COURSE LINK</Text></Pressable> : null}
        {hasMultipleLayouts && <Text style={styles.courseItemMeta}>Stats for the {selectedCourse.layoutLabel} layout</Text>}
        {selectedCourseStats && <View style={styles.courseStatsGrid}>
          <View style={styles.courseStat}><Text style={styles.statLabel}>HOLES</Text><Text style={styles.courseStatValue}>{selectedCourseStats.holes}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.mappedHoles} mapped</Text></View>
          <View style={styles.courseStat}><Text style={styles.statLabel}>PAR</Text><Text style={styles.courseStatValue}>{selectedCourseStats.parHoles ? selectedCourseStats.par : '—'}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.parHoles === selectedCourseStats.holes ? 'All holes' : `${selectedCourseStats.parHoles} of ${selectedCourseStats.holes} holes set`}</Text></View>
          <View style={styles.courseStat}><Text style={styles.statLabel}>DISTANCE</Text><Text style={styles.courseStatValue}>{selectedCourseStats.mappedHoles ? `${selectedCourseStats.distanceFeet.toLocaleString()} ft` : '—'}</Text><Text style={styles.courseStatNote}>Tee to basket, mapped holes</Text></View>
          <View style={styles.courseStat}><Text style={styles.statLabel}>ELEVATION CHANGE</Text><Text style={styles.courseStatValue}>{selectedCourseStats.elevationFeet === null ? '—' : `${selectedCourseStats.elevationFeet} ft`}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.elevationFeet === null ? 'Save tee and basket points to measure' : 'Highest to lowest point'}</Text></View>
        </View>}
        <CourseDetailsFields view={selectedCourse} />
      </View>}
      {selectedCourse && <View style={styles.mapEditor}><View style={styles.mapEditorHeading}><Text style={styles.builderSectionTitle}>Map holes</Text><Text style={styles.mapProgress}>{mappedHoleCount}/{selectedCourse.holes} MAPPED</Text></View><Text style={styles.mapInstruction}>Map each hole with satellite imagery and on-site GPS capture.</Text><Pressable onPress={() => mapLayout(selectedBaseCourse!, selectedCourse.layoutId, 'CourseBuilder')} style={styles.primaryButton}><Text style={styles.primaryButtonText}>{hasMultipleLayouts ? `MAP ${selectedCourse.layoutLabel.toUpperCase()} LAYOUT ↗` : 'MAP SELECTED COURSE ↗'}</Text></Pressable>
        <View style={[styles.mapEditorHeading, styles.parEditorHeading]}><Text style={styles.builderSectionTitle}>Hole pars{hasMultipleLayouts ? ` · ${selectedCourse.layoutLabel}` : ''}</Text><Text style={styles.mapProgress}>PAR {selectedCourse.layouts?.reduce((sum, layout) => sum + (layout.par ?? 0), 0) ?? 0}</Text></View>
        {Array.from({ length: selectedCourse.holes }, (_, index) => {
          const layout = selectedCourse.layouts?.[index];
          const par = layout?.par;
          const holeNumber = index + 1;
          return <View key={holeNumber} style={styles.parRow}>
            <View style={styles.courseItemCopy}><Text style={styles.courseItemName}>Hole {String(holeNumber).padStart(2, '0')}</Text><Text style={styles.courseItemMeta}>{layout?.tee && layout.basket ? [`Mapped · ${holeDistanceFeet(layout)} ft`, holeElevationFeet(layout) === null ? null : formatElevation(holeElevationFeet(layout)!)].filter(Boolean).join(' · ') : 'Not mapped'}</Text></View>
            <Pressable onPress={() => setHolePar(par === undefined ? 3 : Math.max(PAR_OPTIONS[0], par - 1), holeNumber)} style={styles.parStepButton} accessibilityRole="button" accessibilityLabel={`Lower par for hole ${holeNumber}`}><Text style={styles.parStepText}>−</Text></Pressable>
            <Text style={styles.parStepValue}>{par ?? '—'}</Text>
            <Pressable onPress={() => setHolePar(par === undefined ? 3 : Math.min(PAR_OPTIONS[PAR_OPTIONS.length - 1], par + 1), holeNumber)} style={styles.parStepButton} accessibilityRole="button" accessibilityLabel={`Raise par for hole ${holeNumber}`}><Text style={styles.parStepText}>+</Text></Pressable>
            <Pressable onPress={() => deleteHole(selectedCourse, holeNumber)} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete hole ${holeNumber}`}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable>
          </View>;
        })}
        <Pressable onPress={() => addHoleToCourse(selectedCourse.id)} style={styles.addHoleButton} accessibilityRole="button"><Text style={styles.addHoleButtonText}>+ ADD HOLE</Text></Pressable>
      </View>}
      <Text style={styles.builderFootnote}>Coordinates are captured only when you save a point. Glide Path does not track your location in the background.</Text>
    </ScrollView>
  </>;
};
