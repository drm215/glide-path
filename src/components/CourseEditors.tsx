import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { addCourseEditor, getCourseEditors, removeCourseEditor, type CourseEditor } from '../../lib/api';
import type { Course } from '../../lib/types';
import { errorMessage } from '../format';
import { useApp } from '../state/AppState';
import { styles } from '../theme';

// A course's owners and admins, for one of them: they edit it, invite others as owners or admins
// by email, and remove them. Everyone can find and play every course.
export const CourseEditors = ({ course }: { course: Course }) => {
  const { account } = useApp();
  const [editors, setEditors] = useState<CourseEditor[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'admin'>('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const token = account?.token;
  const uid = course.uid;

  useEffect(() => {
    if (!token || !uid) return;
    let current = true;
    getCourseEditors(token, uid).then((result) => { if (current) setEditors(result.editors); }, () => { if (current) setEditors(null); });
    return () => { current = false; };
  }, [token, uid]);

  if (!token || !uid) return <Text style={[styles.courseItemMeta, styles.sourceNote]}>You can add owners and admins once this course has synced.</Text>;

  const invite = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      setEditors((await addCourseEditor(token, uid, email.trim(), role)).editors);
      setEmail('');
    } catch (problem) {
      setError(errorMessage(problem, 'Could not invite them.'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (editor: CourseEditor) => {
    setError('');
    try {
      await removeCourseEditor(token, uid, editor.userId);
      setEditors((current) => current?.filter((item) => item.userId !== editor.userId) ?? null);
    } catch (problem) {
      setError(errorMessage(problem, 'Could not remove them.'));
    }
  };

  return <View style={styles.sharingSection}>
    <Text style={styles.courseItemName}>Owners and admins</Text>
    <Text style={styles.courseItemMeta}>Every course is public: anyone can find and play it. Owners and admins can also map and edit it, invite others, and delete it. Invite them by the email they use for Glide Path.</Text>
    {editors?.map((editor) => <View key={editor.userId} style={styles.sharingMember}>
      <Text style={[styles.courseItemMeta, styles.toggleCopy]}>{editor.displayName} · {editor.role === 'owner' ? 'Owner' : 'Admin'}{editor.creator ? ' (created it)' : ''} · {editor.email}</Text>
      {!editor.creator && <Pressable onPress={() => remove(editor)} accessibilityRole="button" accessibilityLabel={`Remove ${editor.displayName} as ${editor.role}`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>REMOVE</Text></Pressable>}
    </View>)}
    <View style={styles.typeRow}>
      {(['admin', 'owner'] as const).map((option) => <Pressable key={option} onPress={() => setRole(option)} style={[styles.typeButton, styles.sheetTypeButton, role === option && styles.typeButtonSelected]} accessibilityRole="button" accessibilityState={{ selected: role === option }}>
        <Text style={[styles.typeText, role === option && styles.typeTextSelected]}>{option === 'admin' ? 'Admin' : 'Owner'}</Text>
      </Pressable>)}
    </View>
    <View style={styles.sharingAdd}>
      <TextInput value={email} onChangeText={setEmail} onSubmitEditing={invite} placeholder="their@email.com" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.toggleCopy]} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Email to invite" returnKeyType="send" />
      <Pressable onPress={invite} disabled={busy || !email.trim()} style={[styles.courseLink, styles.sharingAddButton, (busy || !email.trim()) && styles.disabledButton]} accessibilityRole="button"><Text style={styles.courseLinkText}>{busy ? 'INVITING…' : 'INVITE'}</Text></Pressable>
    </View>
    {error ? <Text style={styles.authError}>{error}</Text> : null}
  </View>;
};
