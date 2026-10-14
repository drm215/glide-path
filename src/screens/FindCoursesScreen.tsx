import * as Location from 'expo-location';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { courseShareUrl, getPublicCourse, searchCourses, type PublicCourse, type PublicCourseSummary } from '../../lib/api';
import { MAIN_LAYOUT_ID } from '../../lib/layouts';
import { styles } from '../theme';
import { CourseMap } from '../components/CourseMap';
import { courseAddressLine, errorMessage } from '../format';
import { ScreenHeading } from '../components/ScreenHeading';
import { shareLink } from '../links';
import { openHole3d } from '../navigation';
import { useApp } from '../state/AppState';

// A directory course's layouts: its main one, then the rest.
const layoutsOf = (course: PublicCourse) => [
  { id: MAIN_LAYOUT_ID, name: course.layoutName || 'Main', layouts: course.layouts },
  ...(course.extraLayouts ?? []).map(({ id, name, layouts }) => ({ id, name, layouts })),
];

export const FindCoursesScreen = () => {
  const { courses, playPublicCourse, setLocationAllowed, setSelectedCourseId, setSelectedLayoutId } = useApp();
  const [playError, setPlayError] = useState('');
  // The layout being looked at, by its index in layoutsOf(course).
  const [layoutIndex, setLayoutIndex] = useState(0);
  // Plays the chosen layout: a course already in this account's list is just selected.
  const play = async (course: PublicCourse, layoutId: string) => {
    setPlayError('');
    const mine = courses.find((item) => item.uid === course.uid);
    if (mine) {
      setSelectedCourseId(mine.id);
      setSelectedLayoutId(layoutId);
      Alert.alert('Ready to play', `${course.name} is selected for your next round.`);
      return;
    }
    try {
      await playPublicCourse(course, layoutId);
    } catch (error) {
      setPlayError(errorMessage(error, 'Could not reach the server. Try again when you’re online.'));
    }
  };
  const [findQuery, setFindQuery] = useState('');
  const [findResults, setFindResults] = useState<PublicCourseSummary[] | null>(null);
  const [findBusy, setFindBusy] = useState(false);
  const [findError, setFindError] = useState('');
  const [findNearby, setFindNearby] = useState(false);
  const [publicCourse, setPublicCourse] = useState<PublicCourse | null>(null);
  const [publicCourseLoading, setPublicCourseLoading] = useState<string | null>(null);

  const runCourseSearch = async (nearMe: boolean) => {
    setFindBusy(true);
    setFindError('');
    setPublicCourse(null);
    try {
      let near: { latitude: number; longitude: number } | undefined;
      if (nearMe) {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== 'granted') {
          setFindError('Location access is needed to find courses near you.');
          return;
        }
        setLocationAllowed(true);
        const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        near = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      }
      const result = await searchCourses(nearMe ? '' : findQuery, near);
      setFindResults(result.courses);
      setFindNearby(nearMe);
    } catch (error) {
      setFindError(errorMessage(error, 'Search failed.'));
    } finally {
      setFindBusy(false);
    }
  };

  const openPublicCourse = async (uid: string) => {
    setPublicCourseLoading(uid);
    setFindError('');
    try {
      setPublicCourse((await getPublicCourse(uid)).course);
      setLayoutIndex(0);
    } catch (error) {
      setFindError(errorMessage(error, 'Could not load that course.'));
    } finally {
      setPublicCourseLoading(null);
    }
  };

  return <>
    <ScreenHeading eyebrow="COURSE DIRECTORY" title="Find courses." />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {publicCourse ? (() => {
        const layouts = layoutsOf(publicCourse);
        const shown = layouts[Math.min(layoutIndex, layouts.length - 1)];
        const mapped = shown.layouts.filter((hole) => hole?.tee && hole.basket).length;
        const pars = shown.layouts.flatMap((hole) => (hole?.par === undefined ? [] : [hole.par]));
        const mine = courses.find((course) => course.uid === publicCourse.uid);
        const inList = Boolean(mine);
        return <>
          <Pressable onPress={() => setPublicCourse(null)} style={styles.backLink}><Text style={styles.homeButtonText}>‹ RESULTS</Text></Pressable>
          <View style={styles.finalScore}>
            <Text style={styles.menuIntroLabel}>MAPPED BY {publicCourse.mappedBy.toUpperCase()}</Text>
            <Text style={styles.menuIntroTitle}>{publicCourse.name}</Text>
            <Text style={styles.menuIntroCopy}>{[
              layouts.length > 1 ? `${layouts.length} layouts` : null,
              `${shown.layouts.length} ${shown.layouts.length === 1 ? 'hole' : 'holes'}`,
              pars.length ? `Par ${pars.reduce((sum, par) => sum + par, 0)}` : null,
              `${mapped} mapped`,
            ].filter(Boolean).join(' · ')}</Text>
            {courseAddressLine(publicCourse.details) ? <Text style={styles.menuIntroCopy}>{courseAddressLine(publicCourse.details)}</Text> : null}
          </View>
          {/* Pick a layout to see its map and holes, and to play. */}
          {layouts.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {layouts.map((layout, index) => <Pressable key={layout.id} onPress={() => setLayoutIndex(index)} style={[styles.chip, shown === layout && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected: shown === layout }}>
              <Text style={[styles.chipText, shown === layout && styles.chipTextSelected]}>{layout.name}</Text>
            </Pressable>)}
          </ScrollView>}
          {/* 3D works from a course in this account's list (the 3D screen reads it from there). */}
          <CourseMap key={shown.id} layouts={shown.layouts} onOpen3d={mine ? (hole) => openHole3d(mine.id, shown.id, hole) : undefined} />
          {publicCourse.details.notes?.trim() ? <><Text style={styles.fieldLabel}>INFO TO KNOW</Text><Text style={styles.roundCourseNotes}>{publicCourse.details.notes.trim()}</Text></> : null}
          <Pressable onPress={() => play(publicCourse, shown.id)} style={styles.primaryButton} accessibilityRole="button">
            <Text style={styles.primaryButtonText}>{layouts.length > 1 ? 'PLAY THIS LAYOUT' : 'PLAY THIS COURSE'}</Text>
          </Pressable>
          {inList ? <Text style={styles.mapInstruction}>It’s in your courses.</Text> : null}
          {playError ? <Text style={styles.authError}>{playError}</Text> : null}
          <Pressable onPress={() => shareLink(`${publicCourse.name} on Glide Path:`, courseShareUrl(publicCourse.uid))} style={[styles.courseLink, styles.toggleAction]}><Text style={styles.courseLinkText}>SHARE COURSE LINK</Text></Pressable>
        </>;
      })() : <>
        <View style={styles.builderPanel}>
          <Text style={styles.builderLabel}>COURSE, CITY OR STATE</Text>
          <View style={styles.addDiscRow}>
            <TextInput value={findQuery} onChangeText={setFindQuery} onSubmitEditing={() => runCourseSearch(false)} placeholder="e.g. Cedar Grove or PA" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.discInput]} returnKeyType="search" />
            <Pressable onPress={() => runCourseSearch(false)} disabled={findBusy} style={[styles.addDiscButton, findBusy && styles.disabledButton]}><Text style={styles.addDiscButtonText}>SEARCH</Text></Pressable>
          </View>
          <Pressable onPress={() => runCourseSearch(true)} disabled={findBusy} style={[styles.courseLink, styles.toggleAction, findBusy && styles.disabledButton]}><Text style={styles.courseLinkText}>◎ COURSES NEAR ME</Text></Pressable>
        </View>
        {findBusy ? <Text style={styles.mapInstruction}>Searching… The server can take up to a minute to wake if it hasn’t been used recently.</Text> : null}
        {findError ? <Text style={styles.authError}>{findError}</Text> : null}
        {!findBusy && findResults === null && !findError ? <Text style={styles.mapInstruction}>Find courses other Glide Path players have mapped and published, then add them to your courses to play.</Text> : null}
        {!findBusy && findResults?.length === 0 ? <Text style={styles.mapInstruction}>No published courses found{findNearby ? ' near you' : ''} yet.</Text> : null}
        {findResults?.map((result) => <Pressable key={result.uid} onPress={() => openPublicCourse(result.uid)} disabled={publicCourseLoading !== null} style={styles.courseItem} accessibilityRole="button">
          <View style={styles.courseItemCopy}>
            <Text style={styles.courseItemName}>{result.name}</Text>
            <Text style={styles.courseItemMeta}>{[
              [result.city, result.state].filter(Boolean).join(', ') || null,
              `${result.holes} ${result.holes === 1 ? 'hole' : 'holes'}`,
              result.par === null ? null : `Par ${result.par}`,
              result.layoutCount > 1 ? `${result.layoutCount} layouts` : null,
              result.distanceMiles === null ? null : `${result.distanceMiles} mi`,
            ].filter(Boolean).join(' · ')}</Text>
            <Text style={styles.courseItemMeta}>Mapped by {result.mappedBy}</Text>
          </View>
          <Text style={styles.menuArrow}>{publicCourseLoading === result.uid ? '…' : '›'}</Text>
        </Pressable>)}
      </>}
    </ScrollView>
  </>;
};
