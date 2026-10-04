import * as Haptics from 'expo-haptics';
import { Pressable, type PressableProps } from 'react-native';
import { HOLD_DELAY_MS } from '../constants';
import { holdStyles } from '../theme';

// A button that only responds to a press-and-hold, with a light buzz when the hold registers.
// Used during a round so that bumps and stray taps never act.
export const HoldPressable = ({ onPress, style, children, ...rest }: Omit<PressableProps, 'onPress' | 'onLongPress'> & { onPress?: () => void }) => (
  <Pressable
    {...rest}
    delayLongPress={HOLD_DELAY_MS}
    onLongPress={() => {
      Haptics.selectionAsync().catch(() => undefined);
      onPress?.();
    }}
    style={(state) => [typeof style === 'function' ? style(state) : style, state.pressed && holdStyles.holding]}
  >
    {children}
  </Pressable>
);
