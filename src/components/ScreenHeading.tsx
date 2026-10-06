import { Pressable, Text, View } from 'react-native';
import { backTo, goBack, type Screen } from '../navigation';
import { styles } from '../theme';
import { HoldPressable } from './HoldPressable';

// `to: 'previous'` returns to whichever screen opened this one.
export type Back = { to: Screen | 'previous'; label: string; name: string };

export const HOME_BACK: Back = { to: 'Home', label: '⌂ MENU', name: 'the main menu' };
export const COURSES_BACK: Back = { to: 'CourseBuilder', label: '‹ COURSES', name: 'course builder' };
export const NEW_COURSE_BACK: Back = { to: 'NewCourse', label: '‹ NEW COURSE', name: 'the new course' };
export const ROUNDS_BACK: Back = { to: 'Rounds', label: '‹ ROUNDS', name: 'rounds' };
export const PREVIOUS_BACK: Back = { to: 'previous', label: '‹ BACK', name: 'the previous screen' };

// A screen's eyebrow, title and back button. The round screen shows only the back button
// (`compact`), and it needs a hold there like every other round button.
export const ScreenHeading = ({ eyebrow, title, back = HOME_BACK, compact = false, hold = false }: {
  eyebrow?: string; title?: string; back?: Back | null; compact?: boolean; hold?: boolean;
}) => {
  const Button = hold ? HoldPressable : Pressable;
  return (
    <View style={[styles.pageHeading, compact && styles.pageHeadingCompact]}>
      {!compact && <View>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>}
      {back && <Button onPress={() => (back.to === 'previous' ? goBack() : backTo(back.to))} style={styles.homeButton} accessibilityRole="button" accessibilityLabel={`Back to ${back.name}`}>
        <Text style={styles.homeButtonText}>{back.label}</Text>
      </Button>}
    </View>
  );
};
