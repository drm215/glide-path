import { Pressable, Text, View } from 'react-native';
import type { CourseDetails } from '../../lib/types';
import { courseAddressLine } from '../format';
import { openLink } from '../links';
import { styles } from '../theme';

// Directions, call, email and website buttons for whichever details the course has.
export const CourseLinks = ({ course }: { course: CourseDetails }) => {
  const addressLine = courseAddressLine(course);
  const phone = course.phone?.trim();
  const email = course.email?.trim();
  const website = course.website?.trim();
  if (!addressLine && !phone && !email && !website) return null;
  return <View style={styles.courseLinks}>
    {addressLine ? <Pressable onPress={() => openLink(`https://maps.apple.com/?q=${encodeURIComponent(addressLine)}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>DIRECTIONS</Text></Pressable> : null}
    {phone ? <Pressable onPress={() => openLink(`tel:${phone.replace(/[^\d+]/g, '')}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>CALL</Text></Pressable> : null}
    {email ? <Pressable onPress={() => openLink(`mailto:${email}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>EMAIL</Text></Pressable> : null}
    {website ? <Pressable onPress={() => openLink(/^https?:\/\//i.test(website) ? website : `https://${website}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>WEBSITE</Text></Pressable> : null}
  </View>;
};
