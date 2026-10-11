import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { DriveResult, HoleBreakdown } from '../../lib/round-stats';
import { styles } from '../theme';

// One row of a hole grid: its label, and what to show for each hole and in the total column.
// Strings and numbers are shown as text in the row's style; null shows nothing.
export type HoleGridRow<T> = {
  key: string; label: string; style?: 'head' | 'muted'; tall?: boolean;
  cell: (column: T) => ReactNode; total?: ReactNode;
};

const Cell = ({ children, tall, style }: { children: ReactNode; tall?: boolean; style?: HoleGridRow<unknown>['style'] }) => (
  <View style={[styles.holeGridCell, tall && styles.holeGridTallCell]}>
    {typeof children === 'string' || typeof children === 'number'
      ? <Text style={[styles.holeGridText, style === 'head' && styles.holeGridHead, style === 'muted' && styles.holeGridMuted]}>{children}</Text>
      : children}
  </View>
);

// A scorecard laid out sideways: labels down the left, a column per hole that scrolls, and a
// total column when any row has a total. Pressing a column calls `onPress` with that hole.
export const HoleGrid = <T extends { hole: number }>({ rows, columns, active, onPress, pressLabel }: {
  rows: HoleGridRow<T>[]; columns: T[]; active?: number | null; onPress?: (column: T) => void; pressLabel?: (column: T) => string;
}) => (
  <View style={styles.holeGrid}>
    <View style={styles.holeGridLabels}>
      {rows.map((row) => <View key={row.key} style={[styles.holeGridCell, styles.holeGridLabelCell, row.tall && styles.holeGridTallCell]}>
        <Text style={[styles.holeGridLabel, row.style === 'muted' && styles.holeGridLabelMuted]}>{row.label}</Text>
      </View>)}
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.holeGridColumns}>
      {columns.map((column) => <Pressable key={column.hole} disabled={!onPress} onPress={() => onPress?.(column)} style={[styles.holeGridColumn, active === column.hole && styles.holeGridColumnActive]} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={pressLabel?.(column)}>
        {rows.map((row) => <Cell key={row.key} tall={row.tall} style={row.style}>{row.cell(column)}</Cell>)}
      </Pressable>)}
      {rows.some((row) => row.total !== undefined) && <View style={styles.holeGridTotal}>
        {rows.map((row) => <Cell key={row.key} tall={row.tall} style={row.style}>{row.total ?? null}</Cell>)}
      </View>}
    </ScrollView>
  </View>
);

// A hole's score: circled under par (a ringed circle for eagle or better), boxed over par.
export const ScoreMark = ({ strokes, par }: { strokes: number; par: number | null }) => {
  const diff = par === null ? 0 : strokes - par;
  const shape = diff <= -2 ? styles.scoreEagle : diff === -1 ? styles.scoreBirdie : diff === 1 ? styles.scoreBogey : diff >= 2 ? styles.scoreDouble : null;
  return <View style={[styles.scoreMark, shape]}><Text style={[styles.scoreMarkText, shape && styles.scoreMarkTextLight]}>{strokes}</Text></View>;
};

const Ring = ({ inner }: { inner?: 'dot' | 'bullseye' }) => (
  <View style={styles.holeIconRing}>{inner && <View style={inner === 'dot' ? styles.holeIconDot : styles.holeIconBullseye} />}</View>
);

export const ObIcon = () => <View style={styles.holeIconBox}><Text style={styles.holeIconBoxText}>✕</Text></View>;

// Where a drive stopped: a ring in the fairway, with a dot inside C2 or a filled center inside C1.
export const DriveIcon = ({ result }: { result: DriveResult | null }) => {
  switch (result) {
    case 'ace': return <View style={[styles.holeIconRing, styles.holeIconAce]} />;
    case 'c1': return <Ring inner="bullseye" />;
    case 'c2': return <Ring inner="dot" />;
    case 'fairway': return <Ring />;
    case 'rough': return <Text style={styles.holeIconMark}>▲</Text>;
    case 'ob': return <ObIcon />;
    default: return null;
  }
};

// The best circle reached in regulation; nothing when it was missed or can't be told.
export const GreenIcon = ({ green }: { green: HoleBreakdown['green'] }) =>
  green === 'c1' ? <Ring inner="bullseye" /> : green === 'c2' ? <Ring inner="dot" /> : null;

export const HoleGridLegend = () => (
  <View style={styles.holeGridLegend}>
    {([['c1', 'C1'], ['c2', 'C2'], ['fairway', 'Fairway'], ['rough', 'Rough'], ['ob', 'OB'], ['ace', 'Ace']] as const).map(([result, label]) => (
      <View key={result} style={styles.holeGridLegendItem}><DriveIcon result={result} /><Text style={styles.holeGridLegendText}>{label}</Text></View>
    ))}
  </View>
);

const fraction = (count: number, of: number) => (of ? `${count}/${of}` : null);

// A round's scorecard: each hole's length, par and score, then how it was played.
export const RoundScorecard = ({ holes, active, onPressHole }: { holes: HoleBreakdown[]; active?: number | null; onPressHole?: (hole: number) => void }) => {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const lengths = holes.map((hole) => hole.lengthFeet);
  const pars = holes.map((hole) => hole.par);
  const drives = holes.filter((hole) => hole.driving !== null);
  const scrambles = holes.filter((hole) => hole.scramble !== null);
  const greens = holes.filter((hole) => hole.green !== null);
  const putts = (key: 'c1x' | 'c2') => ({ made: sum(holes.map((hole) => hole[key].made)), attempts: sum(holes.map((hole) => hole[key].attempts)) });
  const c1x = putts('c1x');
  const c2 = putts('c2');
  const penalties = sum(holes.map((hole) => hole.penalties));
  const rows: (HoleGridRow<HoleBreakdown> | false)[] = [
    { key: 'hole', label: 'Hole', style: 'head', cell: (hole) => hole.hole, total: 'TOT' },
    lengths.some((feet) => feet !== null) && { key: 'length', label: 'Distance (ft)', style: 'muted', cell: (hole) => hole.lengthFeet, total: lengths.every((feet) => feet !== null) ? sum(lengths as number[]) : null },
    pars.some((par) => par !== null) && { key: 'par', label: 'Par', style: 'muted', cell: (hole) => hole.par, total: pars.every((par) => par !== null) ? sum(pars as number[]) : null },
    { key: 'score', label: 'Score', tall: true, cell: (hole) => <ScoreMark strokes={hole.strokes} par={hole.par} />, total: <Text style={[styles.holeGridText, styles.holeGridHead]}>{sum(holes.map((hole) => hole.strokes))}</Text> },
    drives.length > 0 && { key: 'driving', label: 'Driving', cell: (hole) => <DriveIcon result={hole.driving} />, total: fraction(drives.filter((hole) => hole.driving !== 'rough' && hole.driving !== 'ob').length, drives.length) },
    scrambles.length > 0 && { key: 'scramble', label: 'Scramble', cell: (hole) => hole.scramble === null ? null : <Text style={[styles.holeIconMark, hole.scramble && styles.holeIconCheck]}>{hole.scramble ? '✓' : '✕'}</Text>, total: fraction(scrambles.filter((hole) => hole.scramble).length, scrambles.length) },
    greens.length > 0 && { key: 'greens', label: 'Greens', cell: (hole) => <GreenIcon green={hole.green} />, total: fraction(greens.filter((hole) => hole.green !== 'missed').length, greens.length) },
    c1x.attempts > 0 && { key: 'c1x', label: 'C1X Putting', cell: (hole) => fraction(hole.c1x.made, hole.c1x.attempts), total: fraction(c1x.made, c1x.attempts) },
    c2.attempts > 0 && { key: 'c2', label: 'C2 Putting', cell: (hole) => fraction(hole.c2.made, hole.c2.attempts), total: fraction(c2.made, c2.attempts) },
    holes.some((hole) => hole.throwInFeet !== null) && { key: 'throwIn', label: 'Throw in (ft)', style: 'muted', cell: (hole) => hole.throwInFeet },
    penalties > 0 && { key: 'ob', label: 'OB / Penalty', cell: (hole) => hole.penalties ? <ObIcon /> : null, total: penalties },
  ];
  return <HoleGrid rows={rows.filter((row) => row !== false)} columns={holes} active={active} onPress={onPressHole && ((hole) => onPressHole(hole.hole))} pressLabel={(hole) => `Show map for hole ${hole.hole}`} />;
};
