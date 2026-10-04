import * as Location from 'expo-location';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { courseShareUrl, getPublicCourse, searchCourses, type PublicCourse, type PublicCourseSummary } from '../../lib/api';
import { styles } from '../theme';
import { courseAddressLine, errorMessage } from '../format';
import { ScreenHeading } from '../components/ScreenHeading';
import { shareLink } from '../links';
import { useApp } from '../state/AppState';

export const FindCoursesScreen = () => {
  const { addPublicCourse, courses, setLocationAllowed } = useApp();
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
    } catch (error) {
      setFindError(errorMessage(error, 'Could not load that course.'));
    } finally {
      setPublicCourseLoading(null);
    }
  };

  return <>
    <ScreenHeading eyebrow="COURSE DIRECTORY" title="Find courses." />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {publicCourse ? <>
        <Pressable onPress={() => setPublicCourse(null)} style={styles.backLink}><Text style={styles.homeButtonText}>‹ RESULTS</Text></Pressable>
        <View style={styles.finalScore}>
          <Text style={styles.menuIntroLabel}>MAPPED BY {publicCourse.mappedBy.toUpperCase()}</Text>
          <Text style={styles.menuIntroTitle}>{publicCourse.name}</Text>
          <Text style={styles.menuIntroCopy}>{[
            `${publicCourse.holes} ${publicCourse.holes === 1 ? 'hole' : 'holes'}`,
            publicCourse.par === null ? null : `Par ${publicCourse.par}`,
            publicCourse.mappedHoles ? `${publicCourse.distanceFeet.toLocaleString()} ft` : null,
            `${publicCourse.mappedHoles} mapped`,
            publicCourse.extraLayouts?.length ? `${publicCourse.extraLayouts.length + 1} layouts` : null,
          ].filter(Boolean).join(' · ')}</Text>
          {courseAddressLine(publicCourse.details) ? <Text style={styles.menuIntroCopy}>{courseAddressLine(publicCourse.details)}</Text> : null}
        </View>
        {publicCourse.details.notes?.trim() ? <><Text style={styles.fieldLabel}>INFO TO KNOW</Text><Text style={styles.roundCourseNotes}>{publicCourse.details.notes.trim()}</Text></> : null}
        {courses.some((course) => course.sourceUid === publicCourse.uid || course.uid === publicCourse.uid)
          ? <View style={[styles.primaryButton, styles.disabledButton]}><Text style={styles.primaryButtonText}>IN YOUR COURSES ✓</Text></View>
          : <Pressable onPress={() => addPublicCourse(publicCourse)} style={styles.primaryButton}><Text style={styles.primaryButtonText}>ADD TO MY COURSES</Text></Pressable>}
        <Pressable onPress={() => shareLink(`${publicCourse.name} on Glide Path:`, courseShareUrl(publicCourse.uid))} style={[styles.courseLink, styles.toggleAction]}><Text style={styles.courseLinkText}>SHARE COURSE LINK</Text></Pressable>
      </> : <>
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
