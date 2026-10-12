import MapView, { Marker, Polyline } from 'react-native-maps';
import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { roundShareUrl } from '../../lib/api';
import { holeBreakdown, roundLayouts } from '../../lib/round-stats';
import { courseLayouts, withExistingLayout } from '../../lib/layouts';
import type { Shot } from '../../lib/types';
import { GREEN, styles } from '../theme';
import { RESULT_TYPES } from '../constants';
import { formatScoreToPar, formatSessionDate, formatThrowDetail } from '../format';
import { regionForPoints } from '../geo';
import { countStrokes, scoreSummary } from '../scoring';
import { BasketCircles } from '../components/BasketCircles';
import { HoleGridLegend, RoundScorecard } from '../components/HoleGrid';
import { StatsSummary } from '../components/StatsSummary';
import { ROUNDS_BACK, ScreenHeading } from '../components/ScreenHeading';
import { ThrowEditorSheet, type ThrowTarget } from '../components/ThrowEditorSheet';
import { shareLink } from '../links';
import { backTo, go, openHole3d, openHoleHistory } from '../navigation';
import { useApp } from '../state/AppState';

export const RoundDetailScreen = () => {
  const { account, courses, deleteRound, history, resumeSession, setRoundShared } = useApp();
  const [expandedHole, setExpandedHole] = useState<number | null>(null);
  const [editingThrow, setEditingThrow] = useState<ThrowTarget | null>(null);
  const roundDetailScrollRef = useRef<ScrollView>(null);
  const holeSectionOffsets = useRef<Record<number, number>>({});

  // The round in the route (/rounds/<id>); ?summary=1 marks one that was just finished.
  const { id, summary } = useLocalSearchParams<{ id: string; summary?: string }>();
  const showingRoundSummary = summary === '1';
  const viewedSession = history.find((session) => session.id === id);
  const viewedBaseCourse = courses.find((course) => course.id === viewedSession?.courseId);
  // The layout the round was played on; undefined if the course or that layout was deleted.
  const viewedCourse = viewedBaseCourse && viewedSession ? withExistingLayout(viewedBaseCourse, viewedSession.layoutId) : undefined;
  // Its holes with the pars it was played with (saved with the round), not the course's current ones.
  const viewedLayouts = roundLayouts(viewedCourse?.layouts ?? [], viewedSession?.pars);
  const viewedLayoutLabel = viewedBaseCourse && courseLayouts(viewedBaseCourse).length > 1 ? (viewedCourse?.layoutLabel ?? viewedSession?.layoutName ?? 'Deleted') : null;
  const viewedHoles = viewedSession
    ? [...new Set(viewedSession.shots.map((shot) => shot.hole))].sort((a, b) => a - b).map((holeNumber) => {
      const holeShots = viewedSession.shots.filter((shot) => shot.hole === holeNumber);
      return { hole: holeNumber, shots: holeShots, par: viewedLayouts[holeNumber - 1]?.par, feet: holeShots.reduce((sum, shot) => sum + shot.feet, 0) };
    })
    : [];
  const viewedScore = viewedSession ? scoreSummary(viewedSession.shots, viewedLayouts) : null;
  const viewedPar = viewedHoles.reduce((sum, item) => sum + (item.par ?? 0), 0);
  const viewedStrokes = viewedScore?.strokes ?? viewedSession?.shots.length ?? 0;
  const viewedToPar = viewedScore?.toPar ?? null;
  // How each hole was played, for the scorecard; the course length when every hole is mapped.
  const viewedBreakdown = viewedSession ? holeBreakdown(viewedSession.shots, viewedLayouts) : [];
  const viewedLength = viewedBreakdown.length && viewedBreakdown.every((item) => item.lengthFeet !== null) ? viewedBreakdown.reduce((sum, item) => sum + item.lengthFeet!, 0) : null;
  const viewedResults = RESULT_TYPES.map((result) => ({
    ...result,
    count: viewedHoles.filter((item) => item.par !== undefined && result.matches(countStrokes(item.shots) - item.par)).length,
  })).filter((result) => result.count > 0);

  // Tapping a hole in a past round opens its map, or closes it if it's already open.
  const toggleRoundHoleMap = (holeNumber: number, scrollToSection = false) => {
    const opening = expandedHole !== holeNumber;
    setExpandedHole(opening ? holeNumber : null);
    const offset = holeSectionOffsets.current[holeNumber];
    if (opening && scrollToSection && offset !== undefined) roundDetailScrollRef.current?.scrollTo({ y: Math.max(0, offset - 8), animated: true });
  };

  const renderRoundHoleMap = (holeNumber: number, holeShots: Shot[]) => {
    const layout = viewedCourse?.layouts?.[holeNumber - 1];
    const throws = holeShots.flatMap((shot, index) => shot.latitude !== undefined && shot.longitude !== undefined ? [{ index, shot, coordinate: { latitude: shot.latitude, longitude: shot.longitude } }] : []);
    const region = regionForPoints([...(layout?.tee ? [layout.tee] : []), ...(layout?.basket ? [layout.basket] : []), ...throws.map((item) => item.coordinate)]);
    if (!region) return <Text style={styles.mapInstruction}>No map positions were saved for this hole.</Text>;
    const path = [...(layout?.tee ? [layout.tee] : []), ...throws.map((item) => item.coordinate)];
    return <View style={styles.roundHoleMap}>
      <MapView style={styles.satelliteMap} mapType="satellite" initialRegion={region} showsMyLocationButton={false}>
        {layout?.tee && layout.basket && <Polyline coordinates={[layout.tee, layout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
        {path.length > 1 && <Polyline coordinates={path} strokeColor="#df8547" strokeWidth={3} />}
        {layout?.tee && <Marker coordinate={layout.tee} title={`Hole ${holeNumber} tee box`} pinColor="#1d684c" />}
        {layout?.basket && <BasketCircles basket={layout.basket} />}
        {layout?.basket && <Marker coordinate={layout.basket} title={`Hole ${holeNumber} basket`} pinColor="#d77d42" />}
        {throws.map((item) => <Marker key={`${item.index}-${item.coordinate.latitude}`} coordinate={item.coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={`Throw ${item.index + 1}`} description={formatThrowDetail(item.shot)}><View style={[styles.shotMarker, item.shot.lie === 'OB' && styles.obMarker]}><Text style={styles.shotPinText}>{item.index + 1}</Text></View></Marker>)}
      </MapView>
      {!viewedCourse && <View pointerEvents="none" style={styles.boardCaption}><Text style={styles.boardCaptionText}>COURSE OR LAYOUT DELETED · NO TEE OR BASKET</Text></View>}
    </View>;
  };

  return <>
    <ScreenHeading eyebrow={showingRoundSummary ? 'ROUND COMPLETE' : viewedSession ? formatSessionDate(viewedSession).toUpperCase() : 'ROUND'} title={`${viewedSession?.courseName ?? 'Round'}.`} back={showingRoundSummary ? undefined : ROUNDS_BACK} />
    <ScrollView ref={roundDetailScrollRef} contentContainerStyle={styles.content}>
      {!viewedSession ? <Text style={styles.mapInstruction}>This round is no longer available.</Text> : <>
        <View style={styles.finalScore}>
          <Text style={styles.menuIntroLabel}>FINAL SCORE</Text>
          <View style={styles.roundHeader}>
            <View style={[styles.roundHeaderBadge, viewedToPar === 0 && styles.roundHeaderBadgeEven, viewedToPar != null && viewedToPar > 0 && styles.roundHeaderBadgeOver]}>
              <Text style={styles.roundHeaderBadgeText}>{viewedToPar == null ? viewedStrokes : formatScoreToPar(viewedToPar)}</Text>
            </View>
            <View style={styles.roundHeaderFigures}>
              <Text style={styles.roundHeaderFigure}>Total <Text style={styles.roundHeaderFigureValue}>{viewedStrokes}</Text></Text>
              {viewedScore?.holesWithPar ? <Text style={styles.roundHeaderFigure}>Par <Text style={styles.roundHeaderFigureValue}>{viewedPar}</Text></Text> : null}
              {viewedLength !== null && <Text style={styles.roundHeaderFigure}>Dist <Text style={styles.roundHeaderFigureValue}>{viewedLength.toLocaleString()} ft</Text></Text>}
            </View>
          </View>
          <Text style={styles.menuIntroCopy}>{[
            `${viewedHoles.length} ${viewedHoles.length === 1 ? 'hole' : 'holes'}`,
            viewedLayoutLabel ? `${viewedLayoutLabel} layout` : null,
            `${viewedSession.shots.reduce((sum, shot) => sum + shot.feet, 0).toLocaleString()} ft thrown`,
          ].filter(Boolean).join(' · ')}</Text>
          {viewedResults.length > 0 && <View style={styles.resultChips}>{viewedResults.map((result) => <View key={result.label} style={styles.resultChip}><Text style={styles.resultChipText}>{result.count} {result.label}{result.count === 1 || result.label.endsWith('+') || result.label.endsWith('better') ? '' : 's'}</Text></View>)}</View>}
        </View>
        <Pressable onPress={() => resumeSession(viewedSession)} style={[styles.addHoleButton, styles.resumeButton]} accessibilityRole="button"><Text style={styles.addHoleButtonText}>RESUME {viewedSession.mode === 'Round' ? 'ROUND' : 'SESSION'} ▶</Text></Pressable>
        <View style={styles.toggleRow}>
          <View style={styles.toggleCopy}>
            <Text style={styles.courseItemName}>Share this {viewedSession.mode === 'Round' ? 'round' : 'session'}</Text>
            <Text style={styles.courseItemMeta}>{!account ? 'Sign in to share a link to this scorecard.' : viewedSession.shared ? (viewedSession.shareToken ? 'Anyone with the link can see this scorecard and the course it was played on.' : 'Creating link on next sync…') : 'Only you can see this round.'}</Text>
          </View>
          {account
            ? <Switch value={Boolean(viewedSession.shared)} onValueChange={(shared) => setRoundShared(viewedSession.id, shared)} trackColor={{ true: GREEN }} accessibilityLabel="Share this round" />
            : <Pressable onPress={() => go('Account')} style={styles.courseLink}><Text style={styles.courseLinkText}>SIGN IN</Text></Pressable>}
        </View>
        {account && viewedSession.shared && viewedSession.shareToken ? <Pressable onPress={() => shareLink(`My round at ${viewedSession.courseName}:`, roundShareUrl(viewedSession.shareToken!))} style={[styles.courseLink, styles.toggleAction]}><Text style={styles.courseLinkText}>SEND LINK</Text></Pressable> : null}
        <Text style={styles.sectionTitle}>Scorecard</Text>
        <RoundScorecard holes={viewedBreakdown} active={expandedHole} onPressHole={(hole) => toggleRoundHoleMap(hole, true)} />
        <HoleGridLegend />
        {viewedScore && viewedScore.holesWithPar < viewedScore.holesCompleted && <Text style={styles.mapInstruction}>{viewedScore.holesWithPar ? `To par counts only the ${viewedScore.holesWithPar} holes with a par set.` : 'Set pars for this course in Course builder to see your score to par.'}</Text>}
        {viewedSession.mode === 'Practice' && <Text style={styles.mapInstruction}>Practice session</Text>}
        <StatsSummary title="Round summary" rounds={[{ shots: viewedSession.shots, layouts: viewedLayouts }]} />
        <Text style={[styles.sectionTitle, styles.throwByThrowTitle]}>Throw by throw</Text>
        <Text style={styles.mapInstruction}>Tap a hole to see where each throw was logged, or a throw to edit or delete it.</Text>
        {viewedHoles.map((item) => <View key={item.hole} style={styles.roundHole} onLayout={(event) => { holeSectionOffsets.current[item.hole] = event.nativeEvent.layout.y; }}>
          <Pressable onPress={() => toggleRoundHoleMap(item.hole)} style={styles.roundHoleHeader} accessibilityRole="button" accessibilityState={{ expanded: expandedHole === item.hole }}>
            <Text style={styles.roundHoleTitle}>Hole {String(item.hole).padStart(2, '0')} <Text style={styles.roundHoleMapToggle}>{expandedHole === item.hole ? '− MAP' : '+ MAP'}</Text></Text>
            <Text style={styles.roundHoleMeta}>{item.par !== undefined ? `PAR ${item.par} · ` : ''}{countStrokes(item.shots)} {countStrokes(item.shots) === 1 ? 'STROKE' : 'STROKES'}{item.par !== undefined ? ` (${formatScoreToPar(countStrokes(item.shots) - item.par)})` : ''}</Text>
          </Pressable>
          {expandedHole === item.hole && renderRoundHoleMap(item.hole, item.shots)}
          {viewedCourse && <Pressable onPress={() => openHoleHistory(viewedCourse.id, viewedCourse.layoutId, item.hole, viewedSession.mode === 'Practice')} style={styles.textLink} accessibilityRole="button" accessibilityLabel={`Every throw on hole ${item.hole}, across all rounds`}><Text style={styles.textLinkText}>All rounds on this hole ›</Text></Pressable>}
          {viewedCourse && <Pressable onPress={() => openHole3d(viewedCourse.id, viewedCourse.layoutId, item.hole, { round: viewedSession.id, includePractice: viewedSession.mode === 'Practice' })} style={styles.textLink} accessibilityRole="button" accessibilityLabel={`Hole ${item.hole} in 3D`}><Text style={styles.textLinkText}>3D view ›</Text></Pressable>}
          {item.shots.map((shot, index) => <Pressable key={index} onPress={() => setEditingThrow({ sessionId: viewedSession.id, index: viewedSession.shots.indexOf(shot) })} style={styles.throwRow} accessibilityRole="button" accessibilityLabel={`Edit throw ${index + 1} on hole ${item.hole}`}>
            <Text style={[styles.roundThrow, styles.throwRowText]}>{index + 1}.  {formatThrowDetail(shot)}</Text>
            <Text style={styles.throwEditHint}>EDIT</Text>
          </Pressable>)}
        </View>)}
        {showingRoundSummary && <Pressable onPress={() => backTo('Home')} style={styles.finishButton}><Text style={styles.finishButtonText}>DONE</Text></Pressable>}
        <Pressable onPress={() => deleteRound(viewedSession, () => backTo('Rounds'))} style={styles.endSessionButton} accessibilityRole="button"><Text style={styles.endSessionText}>DELETE {viewedSession.mode === 'Round' ? 'ROUND' : 'SESSION'}</Text></Pressable>
      </>}
    </ScrollView>
    {editingThrow && <ThrowEditorSheet target={editingThrow} layouts={viewedCourse?.layouts} onClose={() => setEditingThrow(null)} />}
  </>;
};
