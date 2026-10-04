import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { courseLayouts, layoutDisplayName, withLayout } from '../../lib/layouts';
import { styles } from '../theme';
import { courseStats } from '../geo';
import { COURSES_BACK, ScreenHeading } from '../components/ScreenHeading';
import { CourseDetailsFields } from '../components/CourseDetailsFields';
import { LayoutsEditor } from '../components/LayoutsEditor';
import { useApp } from '../state/AppState';

export const NewCourseScreen = () => {
  const { courseName, mapLayout, newCourseId, newCourseStep, saveNewCourseName, selectedBaseCourse, selectedCourse, setCourseName, setNewCourseStep, navigate } = useApp();


  return <>
    <ScreenHeading eyebrow={`NEW COURSE · STEP ${newCourseStep} OF 4`} title={['Name it.', 'Details.', 'Layouts.', 'Map holes.'][newCourseStep - 1]} back={COURSES_BACK} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.stepDots} accessibilityLabel={`Step ${newCourseStep} of 4`}>
        {['NAME', 'DETAILS', 'LAYOUTS', 'MAP HOLES'].map((label, index) => <View key={label} style={styles.stepDot}>
          <View style={[styles.stepDotMark, index + 1 <= newCourseStep && styles.stepDotMarkDone]} />
          <Text style={[styles.stepDotLabel, index + 1 === newCourseStep && styles.stepDotLabelCurrent]}>{label}</Text>
        </View>)}
      </View>
      {newCourseStep === 1 ? <View style={styles.builderPanel}>
        <Text style={styles.builderLabel}>COURSE NAME</Text>
        <TextInput value={courseName} onChangeText={setCourseName} onSubmitEditing={saveNewCourseName} placeholder="e.g. Cedar Grove" placeholderTextColor="#5f6a63" style={styles.builderInput} returnKeyType="next" autoFocus />
      </View> : !selectedBaseCourse || !selectedCourse || selectedBaseCourse.id !== newCourseId ? <Text style={styles.mapInstruction}>This course is no longer available.</Text>
        : newCourseStep === 2 ? <View style={styles.builderPanel}>
          <Text style={styles.mapInstruction}>All optional. You can change these any time in Course builder.</Text>
          <CourseDetailsFields view={selectedCourse} />
        </View>
        : newCourseStep === 3 ? <View>
          <Text style={styles.mapInstruction}>Name the first layout (for example Main or Red tees), then add any others: different tee pads, pin positions or seasonal setups.</Text>
          <LayoutsEditor base={selectedBaseCourse} view={selectedCourse} />
        </View>
        : <View>
          <Text style={styles.mapInstruction}>Map each layout by walking to every tee and basket. Holes are added as you go: on the last hole, + ADD HOLE adds the next one.</Text>
          {courseLayouts(selectedBaseCourse).map((layout) => {
            const stats = courseStats(withLayout(selectedBaseCourse, layout.id));
            return <View key={layout.id} style={styles.courseItem}>
              <View style={[styles.courseItemCopy, styles.layoutMapCopy]}>
                <Text style={styles.courseItemName}>{layoutDisplayName(layout)}</Text>
                <Text style={styles.courseItemMeta}>{stats.mappedHoles ? `${stats.mappedHoles} of ${stats.holes} ${stats.holes === 1 ? 'hole' : 'holes'} mapped` : 'Not mapped yet'}</Text>
              </View>
              <Pressable onPress={() => mapLayout(selectedBaseCourse, layout.id, 'NewCourse')} style={styles.courseLink} accessibilityRole="button" accessibilityLabel={`Map the ${layoutDisplayName(layout)} layout`}><Text style={styles.courseLinkText}>{stats.mappedHoles ? 'CONTINUE ↗' : 'MAP ↗'}</Text></Pressable>
            </View>;
          })}
        </View>}
      <View style={styles.wizardNavigation}>
        {newCourseStep > 1
          ? <Pressable onPress={() => setNewCourseStep((newCourseStep - 1) as 1 | 2 | 3)} style={styles.wizardNavButton}><Text style={styles.wizardNavText}>‹ BACK</Text></Pressable>
          : <Pressable onPress={() => navigate('CourseBuilder')} style={styles.wizardNavButton}><Text style={styles.wizardNavText}>CANCEL</Text></Pressable>}
        {newCourseStep === 1
          ? <Pressable onPress={saveNewCourseName} disabled={!courseName.trim()} style={[styles.wizardNavButton, styles.wizardNavNext, !courseName.trim() && styles.disabledButton]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>NEXT: DETAILS ›</Text></Pressable>
          : newCourseStep < 4
            ? <Pressable onPress={() => setNewCourseStep((newCourseStep + 1) as 3 | 4)} style={[styles.wizardNavButton, styles.wizardNavNext]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>{newCourseStep === 2 ? 'NEXT: LAYOUTS ›' : 'NEXT: MAP HOLES ›'}</Text></Pressable>
            : <Pressable onPress={() => navigate('CourseBuilder')} style={[styles.wizardNavButton, styles.wizardNavNext]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>DONE ✓</Text></Pressable>}
      </View>
    </ScrollView>
  </>;
};
