import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { addCourseOwner, getCourseOwners, removeCourseOwner, type CourseOwner } from '../../lib/api';
import type { Course } from '../../lib/types';
import { errorMessage } from '../format';
import { useApp } from '../state/AppState';
import { styles } from '../theme';

// A course's owners, for one of them (or a site admin): they edit it, add other owners by email,
// remove them, and delete it. Everyone can find and play every course.
export const CourseEditors = ({ course }: { course: Course }) => {
  const { account } = useApp();
  const [owners, setOwners] = useState<CourseOwner[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const token = account?.token;
  const uid = course.uid;

  useEffect(() => {
    if (!token || !uid) return;
    let current = true;
    getCourseOwners(token, uid).then((result) => { if (current) setOwners(result.owners); }, () => { if (current) setOwners(null); });
    return () => { current = false; };
  }, [token, uid]);

  if (!token || !uid) return <Text style={[styles.courseItemMeta, styles.sourceNote]}>You can add owners once this course has synced.</Text>;

  const add = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      setOwners((await addCourseOwner(token, uid, email.trim())).owners);
      setEmail('');
    } catch (problem) {
      setError(errorMessage(problem, 'Could not add them.'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (owner: CourseOwner) => {
    setError('');
    try {
      await removeCourseOwner(token, uid, owner.userId);
      setOwners((current) => current?.filter((item) => item.userId !== owner.userId) ?? null);
    } catch (problem) {
      setError(errorMessage(problem, 'Could not remove them.'));
    }
  };

  return <View style={styles.sharingSection}>
    <Text style={styles.courseItemName}>Owners</Text>
    <Text style={styles.courseItemMeta}>Every course is public: anyone can find and play it. Its owners can also map and edit it, add other owners, and delete it. Add them by the email they use for Glide Path.</Text>
    {owners?.map((owner) => <View key={owner.userId} style={styles.sharingMember}>
      <Text style={[styles.courseItemMeta, styles.toggleCopy]}>{owner.displayName}{owner.creator ? ' (created it)' : ''} · {owner.email}</Text>
      {!owner.creator && <Pressable onPress={() => remove(owner)} accessibilityRole="button" accessibilityLabel={`Remove ${owner.displayName} as an owner`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>REMOVE</Text></Pressable>}
    </View>)}
    <View style={styles.sharingAdd}>
      <TextInput value={email} onChangeText={setEmail} onSubmitEditing={add} placeholder="their@email.com" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.toggleCopy]} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Email of a new owner" returnKeyType="send" />
      <Pressable onPress={add} disabled={busy || !email.trim()} style={[styles.courseLink, styles.sharingAddButton, (busy || !email.trim()) && styles.disabledButton]} accessibilityRole="button"><Text style={styles.courseLinkText}>{busy ? 'ADDING…' : 'ADD OWNER'}</Text></Pressable>
    </View>
    {error ? <Text style={styles.authError}>{error}</Text> : null}
  </View>;
};
