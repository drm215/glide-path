import { useState } from 'react';
import { Alert, Modal, Pressable, Text, View } from 'react-native';
import { remeasureHole } from '../../lib/rounds';
import type { Disc, HoleLayout, Lie, ThrowStyle, ThrowType } from '../../lib/types';
import { ACTIVE_SESSION_ID, lieLabel, lieOptionsFor, QUALITY_MAX, QUALITY_OPTIONS, STYLE_OPTIONS, TYPE_OPTIONS } from '../constants';
import { useApp } from '../state/AppState';
import { styles } from '../theme';
import { HoldPressable } from './HoldPressable';

// A throw in a past round (by its session id) or in the round in progress (ACTIVE_SESSION_ID).
export type ThrowTarget = { sessionId: string; index: number };

// Edits or deletes one throw. `layouts` are the hole layouts the round was played on, for moving a
// made throw to the basket; `hold` makes every button need a press-and-hold, as during a round.
export const ThrowEditorSheet = ({ target, layouts, hold = false, onClose }: {
  target: ThrowTarget; layouts: HoleLayout[] | undefined; hold?: boolean; onClose: () => void;
}) => {
  const { shots, history, bag, updateSessionShots } = useApp();
  const Button = (hold ? HoldPressable : Pressable) as typeof HoldPressable;
  const editingActive = target.sessionId === ACTIVE_SESSION_ID;
  const editingShots = editingActive ? shots : history.find((session) => session.id === target.sessionId)?.shots;
  const editingShot = editingShots?.[target.index];
  const editDiscOptions = [...new Set([...(editingShot?.disc ? [editingShot.disc] : []), ...bag])];
  const [throwDraft, setThrowDraft] = useState<{ disc: Disc; type: ThrowType; style?: ThrowStyle; lie: Lie; quality: number | null }>(() => ({
    disc: editingShot?.disc ?? '', type: editingShot?.type ?? 'Drive', style: editingShot?.style, lie: editingShot?.lie ?? 'Fairway',
    // Throws rated on the old 1-5 scale are converted to the current scale.
    quality: editingShot?.quality ? Math.min(QUALITY_MAX, Math.max(1, Math.round((editingShot.quality / (editingShot.qualityMax ?? 5)) * QUALITY_MAX))) : null,
  }));

  const saveThrowEdit = () => {
    const { sessionId, index } = target;
    // A throw changed to "in the basket" moves to the basket, as when it's logged that way;
    // distances on the hole are then remeasured from each previous lie.
    const layout = editingShot ? layouts?.[editingShot.hole - 1] : undefined;
    const moveToBasket = throwDraft.lie === 'Basket' && editingShot?.lie !== 'Basket' && layout?.basket;
    updateSessionShots(sessionId, (list) => {
      const edited = list.map((shot, position) => (position === index
        ? {
          ...shot, disc: throwDraft.disc, type: throwDraft.type, style: throwDraft.style, lie: throwDraft.lie,
          ...(throwDraft.quality === null ? {} : { quality: throwDraft.quality, qualityMax: QUALITY_MAX }),
          ...(moveToBasket ? { latitude: layout.basket!.latitude, longitude: layout.basket!.longitude, accuracy: layout.basket!.accuracy } : {}),
        }
        : shot));
      return moveToBasket && editingShot ? remeasureHole(edited, editingShot.hole, layout?.tee) : edited;
    });
    onClose();
  };

  const deleteEditingThrow = () => {
    if (!editingShots || !editingShot) return;
    if (!editingActive && editingShots.length === 1) {
      Alert.alert('Keep one throw', 'A round needs at least one throw.');
      return;
    }
    const { sessionId, index } = target;
    const holeNumber = editingShot.hole;
    const tee = layouts?.[holeNumber - 1]?.tee;
    Alert.alert('Delete this throw?', 'It will be removed from the round, and the score and the next throw’s distance updated.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete throw',
        style: 'destructive',
        onPress: () => {
          updateSessionShots(sessionId, (list) => remeasureHole(list.filter((_, position) => position !== index), holeNumber, tee));
          onClose();
        },
      },
    ]);
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.controlHeading}><Text style={styles.controlTitle}>Edit throw</Text><Text style={styles.controlStep}>{editingShot ? `HOLE ${String(editingShot.hole).padStart(2, '0')}` : ''}</Text></View>
          {editingShot && <Text style={styles.sheetDistance}>{editingShot.feet ? `${editingShot.feet} ft` : 'Distance unavailable'}</Text>}
          <Text style={styles.fieldLabel}>DISC</Text>
          <View style={styles.sheetOptions}>
            {editDiscOptions.map((item) => <Button key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, disc: item }))} style={[styles.chip, styles.sheetChip, throwDraft.disc === item && styles.chipSelected]}><Text style={[styles.chipText, throwDraft.disc === item && styles.chipTextSelected]}>{item}</Text></Button>)}
            {!editDiscOptions.length && <Text style={styles.chipText}>No discs in your bag</Text>}
          </View>
          <Text style={[styles.fieldLabel, styles.typeLabel]}>TYPE OF THROW</Text>
          <View style={styles.typeRow}>
            {TYPE_OPTIONS.map((item) => <Button key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, type: item }))} style={[styles.typeButton, styles.sheetTypeButton, throwDraft.type === item && styles.typeButtonSelected]}><Text style={[styles.typeText, throwDraft.type === item && styles.typeTextSelected]}>{item}</Text></Button>)}
          </View>
          <Text style={[styles.fieldLabel, styles.typeLabel]}>HOW WAS IT THROWN?</Text>
          <View style={[styles.typeRow, styles.lieGrid]}>
            {STYLE_OPTIONS.map((item) => <Button key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, style: item }))} style={[styles.typeButton, styles.sheetTypeButton, styles.styleButton, throwDraft.style === item && styles.typeButtonSelected]}><Text style={[styles.typeText, throwDraft.style === item && styles.typeTextSelected]}>{item}</Text></Button>)}
          </View>
          <Text style={[styles.fieldLabel, styles.typeLabel]}>{throwDraft.type === 'Putt' ? 'PUTT RESULT' : 'WHERE DID IT LAND?'}</Text>
          <View style={[styles.typeRow, styles.lieGrid]}>
            {lieOptionsFor(throwDraft.type).map((item) => <Button key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, lie: item }))} style={[styles.typeButton, styles.sheetTypeButton, styles.lieButton, item === 'OB' && styles.obButton, throwDraft.lie === item && styles.typeButtonSelected]}><Text style={[styles.typeText, item === 'OB' && styles.obText, throwDraft.lie === item && styles.typeTextSelected]}>{lieLabel(item, throwDraft.type)}</Text>{item === 'OB' && <Text style={styles.obPenaltyText}>+1 STROKE</Text>}</Button>)}
          </View>
          <Text style={[styles.fieldLabel, styles.typeLabel]}>QUALITY</Text>
          <View style={styles.typeRow}>
            {QUALITY_OPTIONS.map((option) => <Button key={option.value} onPress={() => setThrowDraft((draft) => ({ ...draft, quality: option.value }))} style={[styles.typeButton, styles.qualityButton, throwDraft.quality === option.value && styles.typeButtonSelected]} accessibilityLabel={`Quality ${option.value}, ${option.label}`}><Text style={styles.qualityValue}>{option.value}</Text><Text style={styles.qualityLabel}>{option.label}</Text></Button>)}
          </View>
          <View style={styles.editFooter}>
            <Button onPress={deleteEditingThrow} style={styles.sheetFooterButton}><Text style={styles.endSessionText}>DELETE</Text></Button>
            <View style={styles.editFooterActions}>
              <Button onPress={onClose} style={styles.sheetFooterButton}><Text style={styles.undoText}>CANCEL</Text></Button>
              <Button onPress={saveThrowEdit} style={[styles.sheetFooterButton, styles.saveButton]}><Text style={styles.saveButtonText}>SAVE</Text></Button>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
};
