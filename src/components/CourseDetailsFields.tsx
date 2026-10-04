import { Text, TextInput, View } from 'react-native';
import type { CourseView } from '../../lib/layouts';
import { courseStreet, formatPhone } from '../format';
import { useApp } from '../state/AppState';
import { styles } from '../theme';
import { CourseLinks } from './CourseLinks';

// Address, contact details, info to know, and the quick-action links; used by Course builder
// and the new-course flow.
export const CourseDetailsFields = ({ view }: { view: CourseView }) => {
  const { updateCourseDetails } = useApp();
  return <>
  <Text style={styles.builderLabel}>STREET</Text>
  <TextInput value={courseStreet(view)} onChangeText={(street) => updateCourseDetails(view.id, { street, address: undefined })} placeholder="123 Park Road" placeholderTextColor="#5f6a63" style={styles.builderInput} textContentType="streetAddressLine1" />
  <View style={styles.cityStateRow}>
    <View style={styles.cityField}>
      <Text style={[styles.builderLabel, styles.detailLabel]}>CITY</Text>
      <TextInput value={view.city ?? ''} onChangeText={(city) => updateCourseDetails(view.id, { city })} placeholder="City" placeholderTextColor="#5f6a63" style={styles.builderInput} textContentType="addressCity" />
    </View>
    <View style={styles.stateField}>
      <Text style={[styles.builderLabel, styles.detailLabel]}>STATE</Text>
      <TextInput value={view.state ?? ''} onChangeText={(state) => updateCourseDetails(view.id, { state: state.toUpperCase() })} placeholder="ST" placeholderTextColor="#5f6a63" style={styles.builderInput} autoCapitalize="characters" autoCorrect={false} maxLength={2} textContentType="addressState" />
    </View>
  </View>
  <Text style={[styles.builderLabel, styles.detailLabel]}>PHONE</Text>
  <TextInput value={view.phone ?? ''} onChangeText={(phone) => updateCourseDetails(view.id, { phone: formatPhone(phone) })} placeholder="(555) 123-4567" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="phone-pad" textContentType="telephoneNumber" />
  <Text style={[styles.builderLabel, styles.detailLabel]}>EMAIL</Text>
  <TextInput value={view.email ?? ''} onChangeText={(email) => updateCourseDetails(view.id, { email })} placeholder="contact@example.com" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" />
  <Text style={[styles.builderLabel, styles.detailLabel]}>WEBSITE</Text>
  <TextInput value={view.website ?? ''} onChangeText={(website) => updateCourseDetails(view.id, { website })} placeholder="udisc.com/courses/…" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="url" autoCapitalize="none" autoCorrect={false} textContentType="URL" />
  <Text style={[styles.builderLabel, styles.detailLabel]}>INFO TO KNOW</Text>
  <TextInput value={view.notes ?? ''} onChangeText={(notes) => updateCourseDetails(view.id, { notes })} placeholder="Parking, fees, hours, restrooms, mandos, water hazards…" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.notesInput]} multiline textAlignVertical="top" />
  <CourseLinks course={view} />
  </>;
};
