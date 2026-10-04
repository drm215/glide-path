import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { MAIN_LAYOUT_ID, courseLayouts, layoutDisplayName } from '../../lib/layouts';
import type { Course } from '../../lib/types';
import { styles } from '../theme';
import { ScreenHeading } from '../components/ScreenHeading';
import { go } from '../navigation';
import { useApp } from '../state/AppState';

export const HomeScreen = () => {
  const { confirmNewSession, courses, history, hole, mode, practiceFocus, selectedCourse, selectedCourseId, selectedLayoutId, sessionActive, shots } = useApp();
  const [roundPickerOpen, setRoundPickerOpen] = useState(false);
  // The course whose layouts the round picker is showing; null while choosing the course.
  const [roundPickerCourseId, setRoundPickerCourseId] = useState<string | null>(null);

  // Starting a round asks for the course, then the layout when the course has more than one.
  const startRound = () => {
    if (!courses.length) {
      Alert.alert('Create a course first', 'Add a course in Course Builder before starting a round.');
      return;
    }
    setRoundPickerCourseId(null);
    setRoundPickerOpen(true);
  };

  const pickRoundCourse = (course: Course) => {
    if (courseLayouts(course).length > 1) {
      setRoundPickerCourseId(course.id);
      return;
    }
    pickRoundLayout(course, MAIN_LAYOUT_ID);
  };

  const pickRoundLayout = (course: Course, layoutId: string) => {
    setRoundPickerOpen(false);
    setRoundPickerCourseId(null);
    confirmNewSession('Round', layoutId, course.id);
  };

  return <>
    <ScreenHeading eyebrow="DISC GOLF FIELD LOG" title="Ready when you are." back={null} />
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {sessionActive && <Pressable onPress={() => go('Round')} style={[styles.menuItem, styles.menuItemPrimary, styles.resumeItem]} accessibilityRole="button">
        <Text style={[styles.menuNumber, styles.menuNumberPrimary]}>▶</Text><View style={styles.menuItemCopy}><Text style={[styles.menuTitle, styles.menuTitlePrimary]}>Resume {mode === 'Round' ? 'round' : 'practice'}</Text><Text style={[styles.menuSubtitle, styles.menuSubtitlePrimary]}>{mode === 'Round' ? selectedCourse?.name ?? 'Round' : `${practiceFocus} practice`} · Hole {hole} · {shots.length} {shots.length === 1 ? 'throw' : 'throws'}</Text></View><Text style={[styles.menuArrow, styles.menuArrowPrimary]}>›</Text>
      </Pressable>}
      <View style={styles.menuOptions}>
        <Pressable onPress={() => go('CourseBuilder')} style={styles.menuItem}>
          <Text style={styles.menuNumber}>01</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Course builder</Text><Text style={styles.menuSubtitle}>Create and choose your courses</Text></View><Text style={styles.menuArrow}>›</Text>
        </Pressable>
        <Pressable onPress={() => go('FindCourses')} style={styles.menuItem}>
          <Text style={styles.menuNumber}>02</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Find courses</Text><Text style={styles.menuSubtitle}>Search courses other players have mapped</Text></View><Text style={styles.menuArrow}>›</Text>
        </Pressable>
        <Pressable onPress={() => go('BagBuilder')} style={styles.menuItem}>
          <Text style={styles.menuNumber}>03</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Bag builder</Text><Text style={styles.menuSubtitle}>Add and select your discs</Text></View><Text style={styles.menuArrow}>›</Text>
        </Pressable>
        <Pressable onPress={() => go('Practice')} style={styles.menuItem}>
          <Text style={styles.menuNumber}>04</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Practice</Text><Text style={styles.menuSubtitle}>{"Choose a focus for today's session"}</Text></View><Text style={styles.menuArrow}>›</Text>
        </Pressable>
        <Pressable onPress={() => go('Rounds')} style={styles.menuItem}>
          <Text style={styles.menuNumber}>05</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Rounds</Text><Text style={styles.menuSubtitle}>{history.length ? `${history.length} previous ${history.length === 1 ? 'session' : 'sessions'}` : 'Review your previous rounds'}</Text></View><Text style={styles.menuArrow}>›</Text>
        </Pressable>
        <Pressable onPress={() => go('Insights')} style={styles.menuItem}>
          <Text style={styles.menuNumber}>06</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Stats</Text><Text style={styles.menuSubtitle}>Scores, putting, drives and discs</Text></View><Text style={styles.menuArrow}>›</Text>
        </Pressable>
        <Pressable onPress={startRound} style={[styles.menuItem, !sessionActive && styles.menuItemPrimary]}>
          <Text style={[styles.menuNumber, !sessionActive && styles.menuNumberPrimary]}>07</Text><View style={styles.menuItemCopy}><Text style={[styles.menuTitle, !sessionActive && styles.menuTitlePrimary]}>{sessionActive ? 'Start a new round' : 'Start a round'}</Text><Text style={[styles.menuSubtitle, !sessionActive && styles.menuSubtitlePrimary]}>Track throws hole by hole</Text></View><Text style={[styles.menuArrow, !sessionActive && styles.menuArrowPrimary]}>↗</Text>
        </Pressable>
      </View>
    </ScrollView>

    <Modal visible={roundPickerOpen} transparent animationType="slide" onRequestClose={() => setRoundPickerOpen(false)}>
      <View style={styles.sheetBackdrop}>
        <View style={[styles.sheet, styles.pickerSheet]}>
          {(() => {
            const pickerCourse = courses.find((course) => course.id === roundPickerCourseId);
            return <>
              <View style={styles.controlHeading}><Text style={styles.controlTitle}>{pickerCourse ? 'Which layout?' : 'Which course?'}</Text><Text style={styles.controlStep}>{pickerCourse ? '02 / 02' : '01 / 02'}</Text></View>
              {pickerCourse && <Text style={styles.sheetDistance}>{pickerCourse.name}</Text>}
              <ScrollView style={styles.pickerList}>
                {pickerCourse
                  ? courseLayouts(pickerCourse).map((layout) => {
                    const current = pickerCourse.id === selectedCourseId && layout.id === selectedLayoutId;
                    return <Pressable key={layout.id} onPress={() => pickRoundLayout(pickerCourse, layout.id)} style={[styles.courseItem, current && styles.courseItemSelected]} accessibilityRole="button"><View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{layoutDisplayName(layout)}</Text><Text style={styles.courseItemMeta}>{layout.holes} {layout.holes === 1 ? 'hole' : 'holes'}</Text></View><Text style={styles.courseSelectedMark}>{current ? '✓' : '›'}</Text></Pressable>;
                  })
                  : courses.map((course) => {
                    const layoutCount = courseLayouts(course).length;
                    const current = course.id === selectedCourseId;
                    return <Pressable key={course.id} onPress={() => pickRoundCourse(course)} style={[styles.courseItem, current && styles.courseItemSelected]} accessibilityRole="button"><View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{course.name}</Text><Text style={styles.courseItemMeta}>{layoutCount > 1 ? `${layoutCount} layouts` : `${course.holes} ${course.holes === 1 ? 'hole' : 'holes'}`}</Text></View><Text style={styles.courseSelectedMark}>{current ? '✓' : '›'}</Text></Pressable>;
                  })}
              </ScrollView>
              <View style={styles.editFooter}>
                {pickerCourse ? <Pressable onPress={() => setRoundPickerCourseId(null)} style={styles.sheetFooterButton}><Text style={styles.undoText}>‹ BACK</Text></Pressable> : <View />}
                <Pressable onPress={() => setRoundPickerOpen(false)} style={styles.sheetFooterButton}><Text style={styles.undoText}>CANCEL</Text></Pressable>
              </View>
            </>;
          })()}
        </View>
      </View>
    </Modal>
  </>;
};
