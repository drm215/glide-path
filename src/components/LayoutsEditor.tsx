import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { MAIN_LAYOUT_ID, courseLayouts, layoutDisplayName, withLayout, type CourseView } from '../../lib/layouts';
import type { Course, CourseLayout } from '../../lib/types';
import { courseStats } from '../geo';
import { useApp } from '../state/AppState';
import { styles } from '../theme';
import { newSessionId } from '../time';

// Layout list, rename and add; used by Course builder and the new-course flow. `view` is the
// selected layout of `base`.
export const LayoutsEditor = ({ base, view }: { base: Course; view: CourseView }) => {
  const { updateCourses, updateCourseLayout, selectLayout, deleteLayout } = useApp();
  const [newLayoutName, setNewLayoutName] = useState('');
  const viewLayouts = courseLayouts(base);

  const addLayout = (copySelected: boolean) => {
    const id = `layout-${newSessionId()}`;
    const name = newLayoutName.trim() || `Layout ${viewLayouts.length + 1}`;
    const layout: CourseLayout = copySelected
      ? { id, name, holes: view.holes, layouts: Array.from({ length: view.holes }, (_, index) => ({ ...(view.layouts?.[index] ?? { tee: null, basket: null }) })) }
      : { id, name, holes: 1, layouts: [{ tee: null, basket: null }] };
    updateCourses((current) => current.map((course) => (course.id === base.id ? { ...course, extraLayouts: [...(course.extraLayouts ?? []), layout] } : course)));
    selectLayout(id);
    setNewLayoutName('');
  };

  return <>
    <View style={styles.mapEditorHeading}><Text style={styles.builderSectionTitle}>Layouts</Text><Text style={styles.mapProgress}>{viewLayouts.length} {viewLayouts.length === 1 ? 'LAYOUT' : 'LAYOUTS'}</Text></View>
    <Text style={styles.mapInstruction}>Each layout has its own holes, tees, baskets and pars, such as different tee pads or pin positions. The selected layout is the one you map, edit and play.</Text>
    {viewLayouts.map((layout) => {
      const stats = courseStats(withLayout(base, layout.id));
      const selected = view.layoutId === layout.id;
      return <View key={layout.id} style={[styles.courseItem, selected && styles.courseItemSelected]}>
        <Pressable onPress={() => selectLayout(layout.id)} style={styles.courseItemSelect} accessibilityRole="button" accessibilityState={{ selected }}>
          <View style={styles.courseItemCopy}>
            <Text style={styles.courseItemName}>{layoutDisplayName(layout)}</Text>
            <Text style={styles.courseItemMeta}>{[`${stats.holes} ${stats.holes === 1 ? 'hole' : 'holes'}`, stats.parHoles ? `Par ${stats.par}` : null, `${stats.mappedHoles} mapped`].filter(Boolean).join(' · ')}</Text>
          </View>
          <Text style={styles.courseSelectedMark}>{selected ? '✓' : '○'}</Text>
        </Pressable>
        {layout.id !== MAIN_LAYOUT_ID && <Pressable onPress={() => deleteLayout(base, layout)} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete the ${layoutDisplayName(layout)} layout`}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable>}
      </View>;
    })}
    <Text style={[styles.builderLabel, styles.detailLabel]}>SELECTED LAYOUT NAME</Text>
    <TextInput value={viewLayouts.find((layout) => layout.id === view.layoutId)?.name ?? ''} onChangeText={(name) => updateCourseLayout(view.id, view.layoutId, (layout) => ({ ...layout, name }))} placeholder={view.layoutId === MAIN_LAYOUT_ID ? 'Main' : 'Layout name'} placeholderTextColor="#5f6a63" style={styles.builderInput} />
    <Text style={[styles.builderLabel, styles.detailLabel]}>NEW LAYOUT</Text>
    <TextInput value={newLayoutName} onChangeText={setNewLayoutName} placeholder="e.g. Blue tees or Winter pins" placeholderTextColor="#5f6a63" style={styles.builderInput} />
    <View style={styles.courseLinks}>
      <Pressable onPress={() => addLayout(true)} style={styles.courseLink}><Text style={styles.courseLinkText}>+ COPY OF {view.layoutLabel.toUpperCase()}</Text></Pressable>
      <Pressable onPress={() => addLayout(false)} style={styles.courseLink}><Text style={styles.courseLinkText}>+ BLANK LAYOUT</Text></Pressable>
    </View>
  </>;
};
