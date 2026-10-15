import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { discStats, discThrows, quality, QUALITY_LABELS } from '../../lib/round-stats';
import type { ThrowType } from '../../lib/types';
import { FILTER_TYPES, lieLabel } from '../constants';
import { formatSessionDate } from '../format';
import { PREVIOUS_BACK, ScreenHeading } from '../components/ScreenHeading';
import { DiscCard, DiscFilters, discSessions } from './DiscStatsScreen';
import { openRound } from '../navigation';
import { useGroundElevations } from '../useGroundElevations';
import { useApp } from '../state/AppState';
import { styles } from '../theme';

// Every throw with one disc (/disc?name=, with types=Drive,Putt and practice=1 carried over from
// disc stats): its figures, then each throw longest first, opening the round it's from.
export const DiscThrowsScreen = () => {
  const { courses, history } = useApp();
  const params = useLocalSearchParams<{ name: string; types?: string; practice?: string }>();
  const [types, setTypes] = useState<ThrowType[]>(() => FILTER_TYPES.filter((type) => params.types?.split(',').includes(type)));
  const [practice, setPractice] = useState(params.practice === '1');
  const sessions = discSessions(history, courses, practice);
  const ground = useGroundElevations(sessions);
  const stats = discStats(sessions, { types, ground }).find((item) => item.disc === params.name);
  const throws = discThrows(sessions, params.name, { types, ground });

  return <>
    <ScreenHeading eyebrow="DISC STATS · EVERY THROW" title={`${params.name}.`} back={PREVIOUS_BACK} />
    <ScrollView contentContainerStyle={styles.content}>
      <DiscFilters types={types} setTypes={setTypes} practice={practice} setPractice={setPractice} />
      {stats && <DiscCard stats={stats} />}
      {throws.length ? <>
        <Text style={styles.statsHeading}>Each throw, longest first</Text>
        {throws.map(({ round, shot, feet, flatFeet, riseFeet }, index) => {
          const rating = quality(shot);
          return <Pressable key={`${round.session.id}-${index}`} onPress={() => openRound(round.session.id)} style={styles.courseItem} accessibilityRole="button" accessibilityLabel={`${feet === null ? 'Unmeasured' : `${feet} ft`}${flatFeet === null ? '' : ` (${flatFeet} ft on flat ground)`} ${shot.type.toLowerCase()} on ${formatSessionDate(round.session)}, opens the round`}>
            <Text style={styles.discThrowFeet}>{feet === null ? '—' : `${feet} ft`}</Text>
            <View style={styles.discThrowFlat}>
              <Text style={styles.discThrowFlatFeet}>{flatFeet === null ? '—' : `${flatFeet} ft`}</Text>
              <Text style={styles.statLabel}>FLAT</Text>
            </View>
            <View style={styles.courseItemCopy}>
              <Text style={styles.courseItemName}>{[shot.type, shot.style?.toLowerCase(), shot.lie ? lieLabel(shot.lie, shot.type).toLowerCase() : null, rating ? QUALITY_LABELS[rating].toLowerCase() : null].filter(Boolean).join(' · ')}</Text>
              <Text style={styles.courseItemMeta}>{round.session.courseName} · hole {shot.hole} · {formatSessionDate(round.session)}{round.session.mode === 'Practice' ? ' · practice' : ''}{feet === null ? ' · not measured' : riseFeet ? ` · ${Math.abs(riseFeet)} ft ${riseFeet > 0 ? 'uphill' : 'downhill'}` : ''}</Text>
            </View>
            <Text style={styles.menuArrow}>›</Text>
          </Pressable>;
        })}
      </> : <Text style={styles.mapInstruction}>No throws with this disc match these filters.</Text>}
    </ScrollView>
  </>;
};
