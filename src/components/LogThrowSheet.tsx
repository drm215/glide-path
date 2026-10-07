import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Disc, ThrowType } from '../../lib/types';
import { lieLabel, lieOptionsFor, QUALITY_OPTIONS, STYLE_OPTIONS, TYPE_OPTIONS } from '../constants';
import type { ThrowDetails } from '../storage';
import { styles } from '../theme';
import { HoldPressable } from './HoldPressable';

export type { ThrowDetails };

// The details of a throw, all on one screen: disc, type, style, where it landed and an optional
// quality, starting from the best guesses. NEXT returns to the round screen to save the location
// where the disc is; a throw in the basket saves straight away and moves on, so that button needs a
// hold like other saves. Choosing options takes a tap, since nothing is recorded until then.
export const LogThrowSheet = ({ throwNumber, initial, bag, lastHole, onNext, onCancel }: {
  throwNumber: number;
  initial: ThrowDetails;
  bag: Disc[];
  // Whether this is the course's last hole, where a throw in the basket ends the round instead.
  lastHole: boolean;
  onNext: (details: ThrowDetails) => void;
  onCancel: () => void;
}) => {
  const [details, setDetails] = useState(initial);
  const set = (change: Partial<ThrowDetails>) => setDetails((current) => ({ ...current, ...change }));
  // Putts have results rather than landing spots, so switching type can leave the lie invalid.
  const setType = (type: ThrowType) => set({ type, ...(lieOptionsFor(type).includes(details.lie) ? {} : { lie: type === 'Putt' ? 'Missed' : 'Fairway' }) });

  const option = (key: string, label: string, selected: boolean, onPress: () => void, style: StyleProp<ViewStyle>[], extra?: ReactNode, accessibilityLabel?: string) => (
    <Pressable key={key} onPress={onPress} style={[...style, selected && styles.typeButtonSelected]} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={accessibilityLabel}>
      <Text style={[styles.typeText, selected && styles.typeTextSelected]}>{label}</Text>{extra}
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.sheetBackdrop}>
        <View style={[styles.sheet, styles.logSheet]}>
          <View style={styles.controlHeading}>
            <Text style={styles.controlTitle}>Log throw {throwNumber}</Text>
          </View>
          <ScrollView style={styles.pickerList} keyboardShouldPersistTaps="handled">
            <Text style={styles.fieldLabel}>DISC</Text>
            <View style={styles.sheetOptions}>
              {bag.map((item) => <Pressable key={item} onPress={() => set({ disc: item })} style={[styles.chip, styles.logChip, details.disc === item && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected: details.disc === item }}><Text style={[styles.chipText, details.disc === item && styles.chipTextSelected]}>{item}</Text></Pressable>)}
              {!bag.length && <Text style={styles.chipText}>No discs in your bag; the throw is saved without one.</Text>}
            </View>
            <Text style={[styles.fieldLabel, styles.typeLabel]}>TYPE OF THROW</Text>
            <View style={styles.typeRow}>
              {TYPE_OPTIONS.map((item) => option(item, item, details.type === item, () => setType(item), [styles.typeButton, styles.logButton]))}
            </View>
            {/* Putts aren't saved with a style; the choice is kept in case the type changes back. */}
            {details.type !== 'Putt' && <>
              <Text style={[styles.fieldLabel, styles.typeLabel]}>HOW DID YOU THROW IT?</Text>
              <View style={[styles.typeRow, styles.lieGrid]}>
                {STYLE_OPTIONS.map((item) => option(item, item, details.style === item, () => set({ style: item }), [styles.typeButton, styles.logButton, styles.styleButton]))}
              </View>
            </>}
            <Text style={[styles.fieldLabel, styles.typeLabel]}>{details.type === 'Putt' ? 'PUTT RESULT' : 'WHERE DID IT LAND?'}</Text>
            <View style={[styles.typeRow, styles.lieGrid]}>
              {lieOptionsFor(details.type).map((item) => option(item, lieLabel(item, details.type), details.lie === item, () => set({ lie: item }),
                // Putts have four results, which fit on one row.
                [styles.typeButton, styles.logButton, details.type === 'Putt' ? styles.styleButton : styles.lieButton, item === 'OB' && styles.obButton],
                item === 'OB' ? <Text style={styles.obPenaltyText}>+1 STROKE</Text> : null,
                item === 'OB' ? 'Out of bounds, one penalty stroke' : lieLabel(item, details.type)))}
            </View>
            <Text style={[styles.fieldLabel, styles.typeLabel]}>HOW WAS THE THROW? (OPTIONAL)</Text>
            <View style={styles.typeRow}>
              {QUALITY_OPTIONS.map((item) => <Pressable key={item.value} onPress={() => set({ quality: details.quality === item.value ? null : item.value })} style={[styles.typeButton, styles.logQualityButton, details.quality === item.value && styles.typeButtonSelected]} accessibilityRole="button" accessibilityState={{ selected: details.quality === item.value }} accessibilityLabel={`Quality ${item.value}, ${item.label}`}><Text style={styles.qualityValue}>{item.value}</Text><Text style={styles.qualityLabel}>{item.label}</Text></Pressable>)}
            </View>
          </ScrollView>
          <View style={styles.editFooter}>
            <Pressable onPress={onCancel} style={styles.sheetFooterButton} accessibilityRole="button"><Text style={styles.undoText}>CANCEL</Text></Pressable>
            {details.lie === 'Basket'
              ? <HoldPressable onPress={() => onNext(details)} style={[styles.sheetFooterButton, styles.saveButton]} accessibilityRole="button" accessibilityHint="Press and hold to save the throw in the basket">
                <Text style={styles.saveButtonText}>{lastHole ? 'SAVE ✓' : 'SAVE · NEXT HOLE ›'}</Text>
              </HoldPressable>
              : <Pressable onPress={() => onNext(details)} style={[styles.sheetFooterButton, styles.saveButton]} accessibilityRole="button" accessibilityHint="Returns to the map to save where the disc is">
                <Text style={styles.saveButtonText}>NEXT ›</Text>
              </Pressable>}
          </View>
        </View>
      </View>
    </Modal>
  );
};
