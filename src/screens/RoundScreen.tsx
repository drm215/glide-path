import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Brightness from 'expo-brightness';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, ScrollView, Text, View } from 'react-native';
import { reliableDistances } from '../../lib/round-stats';
import { guessDisc, guessThrowType, suggestDiscs } from '../../lib/rounds';
import type { Disc, Shot, ThrowStyle, ThrowType } from '../../lib/types';
import { styles } from '../theme';
import { ACTIVE_SESSION_ID, GPS_GOOD_ACCURACY_M, GPS_POOR_ACCURACY_M, QUALITY_MAX, ROUND_BRIGHTNESS, ROUND_KEEP_AWAKE_TAG, WARM_FIX_MAX_AGE_MS } from '../constants';
import { nowMs } from '../time';
import { courseAddressLine, formatElevation, formatLie, formatQuality, formatScoreToPar, formatThrowDetail } from '../format';
import { courseStats, feetBetween, holeDistanceFeet, holeElevationFeet, regionAtPoint, regionForHole } from '../geo';
import { countStrokes, scoreSummary } from '../scoring';
import { HoldPressable } from '../components/HoldPressable';
import { BasketCircles } from '../components/BasketCircles';
import { ScreenHeading } from '../components/ScreenHeading';
import { CourseLinks } from '../components/CourseLinks';
import { LogThrowSheet, type ThrowDetails } from '../components/LogThrowSheet';
import { ThrowEditorSheet, type ThrowTarget } from '../components/ThrowEditorSheet';
import { useApp } from '../state/AppState';

// Saving a waiting throw's location: getting a fix, a problem doing so, or a fix too poor to save
// without asking (its accuracy in meters).
type SaveStatus = { kind: 'ready' } | { kind: 'saving' } | { kind: 'error'; message: string } | { kind: 'poor'; accuracy: number };

// A position logged for a throw, and its distance from the previous lie (or the tee).
type LiePoint = { latitude: number; longitude: number; altitude: number | null; accuracy: number | null; feet: number };

export const RoundScreen = () => {
  const { bag, bagDetails, dimRound, disc, finishSession, hasMultipleLayouts, history, hole, locationAllowed, mode, practiceFocus, roundMessage, selectedCourse, setDimRound, setDisc, setHole, setLocationAllowed, setRoundMessage, setShots, setThrowStyle, shots, throwStyle } = useApp();
  // The throw being entered in the log sheet (null when it's closed), then the throw waiting below
  // the map for its location to be saved.
  const [logging, setLogging] = useState<ThrowDetails | null>(null);
  const [pendingThrow, setPendingThrow] = useState<ThrowDetails | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'ready' });
  // A GPS reading too poor to save without asking; kept so SAVE ANYWAY doesn't take another.
  const poorFix = useRef<LiePoint | null>(null);
  const [showCourseInfo, setShowCourseInfo] = useState(false);
  const [editingThrow, setEditingThrow] = useState<ThrowTarget | null>(null);
  const roundScrollRef = useRef<ScrollView>(null);
  const savedBrightness = useRef<number | null>(null);
  // The newest reading from the round screen's GPS watch, and its accuracy in whole meters for display.
  const latestFix = useRef<Location.LocationObject | null>(null);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);

  // Bring the hole number and map back into view whenever the hole changes.
  useEffect(() => {
    roundScrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [hole]);

  // These run while the round screen is the one showing, and stop when another screen opens on top.

  // Keep the screen on. Keep-awake is a nicety; the round works without it.
  useFocusEffect(useCallback(() => {
    activateKeepAwakeAsync(ROUND_KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      Promise.resolve(deactivateKeepAwake(ROUND_KEEP_AWAKE_TAG)).catch(() => undefined);
    };
  }, []));

  // With dimming on, the round screen saves battery by lowering brightness (never raising it), and
  // restores it on the way out. iOS restores brightness itself when the phone locks, so dim again on
  // return. Players turn dimming off when the screen is too dark to read in the sun.
  useFocusEffect(useCallback(() => {
    if (!dimRound) return;
    let left = false;
    const dim = async () => {
      const current = await Brightness.getBrightnessAsync();
      if (left || current <= ROUND_BRIGHTNESS) return;
      savedBrightness.current ??= current;
      await Brightness.setBrightnessAsync(ROUND_BRIGHTNESS);
    };
    dim().catch(() => undefined);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') dim().catch(() => undefined);
    });
    return () => {
      left = true;
      subscription.remove();
      if (savedBrightness.current !== null) Brightness.setBrightnessAsync(savedBrightness.current).catch(() => undefined);
      savedBrightness.current = null;
    };
  }, [dimRound]));

  // Keep a GPS fix warm so logging a throw is instant and as accurate as the phone can manage,
  // rather than waiting on a single cold reading.
  useFocusEffect(useCallback(() => {
    let subscription: Location.LocationSubscription | null = null;
    let left = false;
    (async () => {
      const permission = await Location.getForegroundPermissionsAsync();
      if (left || permission.status !== 'granted') return;
      const started = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Highest, distanceInterval: 1, timeInterval: 1000 }, (fix) => {
        latestFix.current = fix;
        setGpsAccuracy(fix.coords.accuracy === null ? null : Math.round(fix.coords.accuracy));
      });
      if (left) started.remove();
      else subscription = started;
    })().catch(() => undefined);
    return () => {
      left = true;
      subscription?.remove();
      latestFix.current = null;
      setGpsAccuracy(null);
    };
    // Not read here, but granting location access mid-round should start the watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationAllowed]));

  const activeShots = shots.filter((shot) => shot.hole === hole);
  const score = activeShots.length;
  const holeStrokes = countStrokes(activeShots);
  const holeFeet = activeShots.reduce((total, shot) => total + shot.feet, 0);
  const allShots = [...history.flatMap((session) => session.shots), ...shots];
  // Throws whose distances the caddie can trust (not measured from or to a poor GPS reading).
  const reliable = reliableDistances([...history, { shots }]);

  const selectedCourseStats = selectedCourse ? courseStats(selectedCourse) : null;
  const selectedHoleLayout = selectedCourse?.layouts?.[hole - 1];
  const roundScore = scoreSummary(shots, selectedCourse, hole);

  const selectedHoleDistance = holeDistanceFeet(selectedHoleLayout);
  // From the last logged lie on this hole to the basket, once the hole is under way and not finished.
  const lastLie = shots.filter((shot) => shot.hole === hole).findLast((shot) => shot.latitude !== undefined && shot.longitude !== undefined);
  const holeBasket = selectedHoleLayout?.basket;
  const lieToBasket = lastLie && holeBasket && lastLie.lie !== 'Basket' ? {
    feet: Math.round(feetBetween({ latitude: lastLie.latitude!, longitude: lastLie.longitude! }, holeBasket)),
    elevation: typeof lastLie.altitude === 'number' && typeof holeBasket.altitude === 'number' ? Math.round((holeBasket.altitude - lastLie.altitude) / 0.3048) : null,
  } : null;
  // The caddie: discs whose average distance best matches what's left to the basket.
  const caddieFrom = lastLie ? { latitude: lastLie.latitude!, longitude: lastLie.longitude! } : selectedHoleLayout?.tee ?? null;
  const caddieTargetFeet = caddieFrom && holeBasket && !shots.some((shot) => shot.hole === hole && shot.lie === 'Basket') ? Math.round(feetBetween(caddieFrom, holeBasket)) : null;
  const caddieType = guessThrowType(shots.filter((shot) => shot.hole === hole), caddieFrom, holeBasket);
  const caddie = caddieTargetFeet === null ? [] : suggestDiscs(caddieTargetFeet, caddieType, allShots, bag, 3, reliable);
  const mappedShots = activeShots.flatMap((shot, index) =>
    shot.latitude !== undefined && shot.longitude !== undefined ? [{ index, coordinate: { latitude: shot.latitude, longitude: shot.longitude } }] : []);
  const lastMappedShot = mappedShots.at(-1);
  const roundMapRegion = regionForHole(selectedHoleLayout) ?? (lastMappedShot ? regionAtPoint(lastMappedShot.coordinate) : null);
  const latestShot = activeShots.at(-1);
  const throwPath = [...(selectedHoleLayout?.tee ? [selectedHoleLayout.tee] : []), ...mappedShots.map((shot) => shot.coordinate)];

  // Where the throw being logged was thrown from: the last positioned throw on this hole, or the tee.
  const previousLiePoint = () => {
    const previousShot = activeShots.findLast((shot) => shot.latitude !== undefined && shot.longitude !== undefined);
    return previousShot ? { latitude: previousShot.latitude!, longitude: previousShot.longitude! } : selectedHoleLayout?.tee ?? null;
  };

  // Reads the GPS position at the disc, or says what went wrong.
  const captureLie = async (): Promise<{ point: LiePoint } | { error: string }> => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        return { error: permission.canAskAgain ? 'Location permission is needed to log where your disc landed.' : 'Enable location access for Glide Path in Settings, then try again.' };
      }
      setLocationAllowed(true);
      if (!(await Location.hasServicesEnabledAsync())) {
        return { error: 'Turn on Location Services, then try again.' };
      }
      // The round screen's warm fix when it's recent and good; otherwise a fresh reading, keeping
      // whichever of the two is more accurate.
      const accuracyOf = (reading: Location.LocationObject | null) => reading?.coords.accuracy ?? Infinity;
      const warm = latestFix.current && nowMs() - latestFix.current.timestamp <= WARM_FIX_MAX_AGE_MS ? latestFix.current : null;
      let fix = warm;
      if (!fix || accuracyOf(fix) > GPS_GOOD_ACCURACY_M) {
        const fresh = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest, mayShowUserSettingsDialog: true });
        fix = fix && accuracyOf(fix) < accuracyOf(fresh) ? fix : fresh;
      }
      const lie = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      const previous = previousLiePoint();
      return { point: { ...lie, altitude: fix.coords.altitude, accuracy: fix.coords.accuracy, feet: previous ? Math.max(1, Math.round(feetBetween(previous, lie))) : 0 } };
    } catch {
      return { error: 'Could not get a GPS fix. Wait a moment and try again.' };
    }
  };

  // Best guesses for a throw, so most throws need no changes: a drive from the tee, a putt from
  // within C2 of the basket, otherwise an approach; the disc last used for that kind of throw.
  const guessThrow = (): { type: ThrowType; disc: Disc } => {
    const from = previousLiePoint();
    const basket = selectedHoleLayout?.basket;
    const type = guessThrowType(activeShots, from, basket);
    // Newest first: this round's throws, then past rounds from newest to oldest.
    const pastShots = [...history].sort((a, b) => Number(a.id) - Number(b.id)).flatMap((session) => session.shots);
    const recent = [...pastShots, ...shots].reverse();
    // The caddie's pick from where this throw was thrown, then the last disc used for the type.
    const suggested = from && basket ? suggestDiscs(Math.round(feetBetween(from, basket)), type, recent, bag, 1, reliable)[0]?.disc : undefined;
    return { type, disc: suggested ?? guessDisc(type, recent, bag, bagDetails, disc) };
  };

  // Adds a throw to the round in progress. Returns a short description for confirmations.
  const recordThrow = (point: LiePoint, details: Omit<ThrowDetails, 'style'> & { style?: ThrowStyle }) => {
    let { latitude, longitude, altitude, accuracy, feet } = point;
    // A throw that went in is recorded at the basket, measured from the previous lie (or the tee),
    // rather than wherever the player was standing when they logged it.
    const basket = selectedHoleLayout?.basket;
    if (details.lie === 'Basket' && basket) {
      const previous = previousLiePoint();
      latitude = basket.latitude;
      longitude = basket.longitude;
      altitude = basket.altitude ?? null;
      accuracy = basket.accuracy;
      feet = previous ? Math.max(1, Math.round(feetBetween(previous, basket))) : 0;
    }
    const shot: Shot = {
      x: 0.5, y: 0.5, feet, disc: details.disc, type: details.type, hole, courseId: selectedCourse?.id, latitude, longitude, altitude, accuracy,
      style: details.style, lie: details.lie, ...(details.quality === null ? {} : { quality: details.quality, qualityMax: QUALITY_MAX }),
    };
    setShots((current) => [...current, shot]);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    const summary = `Throw ${score + 1} · ${formatThrowDetail(shot)}`;
    if (details.lie !== 'Basket') return summary;
    // A made basket finishes the hole.
    const throwCount = holeStrokes + 1;
    const holeCount = selectedCourse?.holes ?? 18;
    if (hole >= holeCount) {
      setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. That was the last hole.`);
      promptLastHoleComplete();
      return `Hole ${hole} complete in ${throwCount}. That was the last hole.`;
    }
    setHole(hole + 1);
    setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. On to hole ${hole + 1}.`);
    return `Hole ${hole} complete in ${throwCount}. On to hole ${hole + 1}.`;
  };

  // Opens the log sheet with the best guesses.
  const startLogThrow = () => {
    const guess = guessThrow();
    setLogging({ disc: guess.disc, type: guess.type, style: throwStyle, lie: guess.type === 'Putt' ? 'Missed' : 'Fairway', quality: null });
    setRoundMessage('');
  };

  // Records a throw at `point` and clears the throw waiting below the map. A throw in the basket also
  // finishes the hole (see recordThrow).
  const saveThrowAt = (details: ThrowDetails, point: LiePoint) => {
    // Putts are saved without a style, and don't change the style remembered for the next throw.
    const putt = details.type === 'Putt';
    // A made throw is rated good unless the player rated it.
    recordThrow(point, { ...details, style: putt ? undefined : details.style, quality: details.quality ?? (details.lie === 'Basket' ? QUALITY_MAX : null) });
    setDisc(details.disc);
    if (!putt) setThrowStyle(details.style);
    setPendingThrow(null);
    setSaveStatus({ kind: 'ready' });
    poorFix.current = null;
  };

  // A throw in the basket saves straight away, at the mapped basket. Without one, the player is
  // standing at the basket, so a GPS reading is taken automatically and kept however accurate it is;
  // if there's no fix, the throw waits below the map to try again.
  const saveMadeThrow = async (details: ThrowDetails) => {
    const basket = selectedHoleLayout?.basket;
    if (basket) {
      saveThrowAt(details, { latitude: basket.latitude, longitude: basket.longitude, altitude: basket.altitude ?? null, accuracy: basket.accuracy, feet: 0 });
      return;
    }
    setPendingThrow(details);
    setSaveStatus({ kind: 'saving' });
    const reading = await captureLie();
    if ('error' in reading) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setSaveStatus({ kind: 'error', message: reading.error });
      return;
    }
    saveThrowAt(details, reading.point);
  };

  // The sheet's NEXT: a throw in the basket saves now; any other waits below the map for its location.
  const confirmDetails = (details: ThrowDetails) => {
    setLogging(null);
    poorFix.current = null;
    if (details.lie === 'Basket') {
      saveMadeThrow(details);
      return;
    }
    setPendingThrow(details);
    setSaveStatus({ kind: 'ready' });
  };

  const discardPendingThrow = () => {
    setPendingThrow(null);
    poorFix.current = null;
  };

  // Saves the waiting throw where the player is standing. A reading worse than GPS_POOR_ACCURACY_M
  // asks first: SAVE ANYWAY (`acceptPoorFix`) keeps that reading, TRY AGAIN takes another. A throw
  // in the basket only waits here when its automatic reading failed, so any reading will do.
  const savePendingThrow = async (acceptPoorFix = false) => {
    if (!pendingThrow || saveStatus.kind === 'saving') return;
    if (acceptPoorFix && poorFix.current) {
      saveThrowAt(pendingThrow, poorFix.current);
      return;
    }
    setSaveStatus({ kind: 'saving' });
    const reading = await captureLie();
    if ('error' in reading) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setSaveStatus({ kind: 'error', message: reading.error });
      return;
    }
    const { point } = reading;
    if (pendingThrow.lie !== 'Basket' && point.accuracy !== null && point.accuracy > GPS_POOR_ACCURACY_M) {
      poorFix.current = point;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
      setSaveStatus({ kind: 'poor', accuracy: Math.round(point.accuracy) });
      return;
    }
    saveThrowAt(pendingThrow, point);
  };

  const startNextHole = () => {
    setHole((current) => (current >= (selectedCourse?.holes ?? 18) ? 1 : current + 1));
  };

  const goToPreviousHole = () => {
    if (hole <= 1) return;
    const previousHole = hole - 1;
    setHole(previousHole);
  };


  const undoLastThrow = () => {
    const last = activeShots.at(-1);
    if (!last) return;
    Alert.alert('Undo the last throw?', `Throw ${activeShots.length} on hole ${hole} (${formatThrowDetail(last)}) will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Undo throw',
        style: 'destructive',
        onPress: () => setShots((current) => {
          const lastActiveIndex = current.findLastIndex((shot) => shot.hole === hole);
          return current.filter((_, index) => index !== lastActiveIndex);
        }),
      },
    ]);
  };

  const promptLastHoleComplete = () => {
    Alert.alert(
      mode === 'Round' ? 'Round complete' : 'Last hole complete',
      `Hole ${hole} was the last hole on ${selectedCourse?.name ?? 'this course'}. End the ${mode === 'Round' ? 'round' : 'practice session'} and save it to your history?`,
      [
        { text: 'Keep playing', style: 'cancel' },
        { text: mode === 'Round' ? 'End round & see summary' : 'End practice', onPress: finishSession },
      ],
    );
  };

  const finishHole = () => {
    const completeHole = () => {
      if (mode === 'Round' && hole >= (selectedCourse?.holes ?? 18)) {
        promptLastHoleComplete();
        return;
      }
      startNextHole();
    };
    // In a round, a hole normally ends with a throw in the basket; check before moving on without one.
    if (mode === 'Round' && !activeShots.some((shot) => shot.lie === 'Basket')) {
      Alert.alert(
        `Finish hole ${hole}?`,
        activeShots.length
          ? `None of the ${activeShots.length} ${activeShots.length === 1 ? 'throw' : 'throws'} on this hole was logged in the basket. Your score for the hole will be ${holeStrokes}.`
          : 'No throws have been logged on this hole.',
        [
          { text: 'Keep playing', style: 'cancel' },
          { text: 'Finish hole', onPress: completeHole },
        ],
      );
      return;
    }
    completeHole();
  };

  const endSession = () => {
    Alert.alert(
      `End this ${mode === 'Round' ? 'round' : 'practice session'}?`,
      'Your throws will be saved to your session history.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End', onPress: finishSession },
      ],
    );
  };

  return <>
    <ScreenHeading compact hold />
    <ScrollView ref={roundScrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.roundToolbar}>
        <View style={styles.courseLabel}><Text style={styles.holeLabel}>{mode === 'Practice' ? `${practiceFocus.toUpperCase()} PRACTICE` : 'PLAYING AT'}</Text><Text style={styles.courseLabelName}>{selectedCourse?.name ?? 'Practice area'}{hasMultipleLayouts ? ` · ${selectedCourse?.layoutLabel}` : ''}</Text></View>
        <View style={styles.roundHoleNav}>
          <HoldPressable onPress={goToPreviousHole} disabled={hole <= 1} style={[styles.roundHoleArrow, hole <= 1 && styles.holeNavDisabled]} accessibilityRole="button" accessibilityLabel="Previous hole"><Text style={styles.holeNavArrow}>‹</Text></HoldPressable>
          <View style={styles.holeSelector}><Text style={styles.holeLabel}>HOLE</Text><Text style={styles.holeNumber}>{String(hole).padStart(2, '0')}<Text style={styles.holeTotal}> / {selectedCourse?.holes ?? 18}</Text></Text></View>
          <HoldPressable onPress={startNextHole} style={styles.roundHoleArrow} accessibilityRole="button" accessibilityLabel="Next hole"><Text style={styles.holeNavArrow}>›</Text></HoldPressable>
        </View>
      </View>

      {/* Hole and round numbers in one slim strip; practice has no par or round score. */}
      <View style={styles.scoreStrip}>
        {[
          ['HOLE', String(holeStrokes)],
          ['DIST', `${holeFeet} ft`],
          ...(mode === 'Round' ? [
            ['PAR', String(selectedHoleLayout?.par ?? '—')],
            ['ROUND', String(roundScore.strokes)],
            ['TO PAR', roundScore.toPar === null ? '—' : formatScoreToPar(roundScore.toPar)],
            ['THRU', String(roundScore.holesCompleted)],
          ] : []),
        ].map(([label, value]) => <View key={label} style={styles.scoreStripItem}><Text style={styles.scoreStripLabel} numberOfLines={1} adjustsFontSizeToFit>{label}</Text><Text style={styles.scoreStripValue}>{value}</Text></View>)}
      </View>

      {roundMapRegion ? <View style={styles.roundMapFrame}>
        <MapView key={`${selectedCourse?.id}-${hole}`} style={styles.satelliteMap} mapType="satellite" initialRegion={roundMapRegion} showsUserLocation={locationAllowed} showsMyLocationButton={false}>
          {selectedHoleLayout?.tee && selectedHoleLayout.basket && <Polyline coordinates={[selectedHoleLayout.tee, selectedHoleLayout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
          {throwPath.length > 1 && <Polyline coordinates={throwPath} strokeColor="#df8547" strokeWidth={3} />}
          {selectedHoleLayout?.tee && <Marker coordinate={selectedHoleLayout.tee} title={`Hole ${hole} tee box`} pinColor="#1d684c" />}
          {selectedHoleLayout?.basket && <BasketCircles basket={selectedHoleLayout.basket} />}
          {selectedHoleLayout?.basket && <Marker coordinate={selectedHoleLayout.basket} title={`Hole ${hole} basket`} pinColor="#d77d42" />}
          {mappedShots.map((shot) => <Marker key={`${shot.index}-${shot.coordinate.latitude}`} coordinate={shot.coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}><View style={styles.shotMarker}><Text style={styles.shotPinText}>{shot.index + 1}</Text></View></Marker>)}
        </MapView>
        <View pointerEvents="none" style={styles.boardCaption}><Text style={styles.boardCaptionText}>{(selectedCourse?.name ?? 'PRACTICE AREA').toUpperCase()}</Text><Text style={styles.boardScale}>SATELLITE</Text></View>
      </View> : <View style={[styles.roundMapFrame, styles.mapUnavailable]}><Text style={styles.mapUnavailableTitle}>Hole not mapped yet</Text><Text style={styles.mapUnavailableText}>Map this hole in Course builder to see it on the satellite map. You can still log throws.</Text></View>}
      {(selectedHoleDistance !== null || lieToBasket || caddie.length > 0) && <View style={[styles.holeDistance, styles.roundHoleDistance, styles.basketDistances]}>
        {selectedHoleDistance !== null && <View style={styles.basketDistanceRow}><Text style={styles.holeDistanceLabel}>TEE TO BASKET</Text><Text style={styles.holeDistanceValue}>{selectedHoleDistance} ft{holeElevationFeet(selectedHoleLayout) === null ? '' : `  ${formatElevation(holeElevationFeet(selectedHoleLayout)!)}`}</Text></View>}
        {lieToBasket && <View style={styles.basketDistanceRow}><Text style={styles.holeDistanceLabel}>YOUR LIE TO BASKET</Text><Text style={styles.holeDistanceValue}>{lieToBasket.feet} ft{lieToBasket.elevation === null ? '' : `  ${formatElevation(lieToBasket.elevation)}`}</Text></View>}
        {caddie.length > 0 && <View style={styles.caddieRow}>
          <Text style={styles.holeDistanceLabel}>CADDIE · {caddieType.toUpperCase()} · {caddieTargetFeet} FT</Text>
          {caddie.map((item) => <Text key={`${item.disc}-${item.style ?? ''}`} style={styles.caddieText}>{item.disc}{item.style ? ` ${item.style.toLowerCase()}` : ''}  <Text style={styles.caddieMeta}>{caddieType === 'Putt' ? `${item.count} ${item.count === 1 ? 'putt' : 'putts'}` : `avg ${item.averageFeet} ft · ${item.count} ${item.count === 1 ? 'throw' : 'throws'}`}</Text></Text>)}
        </View>}
      </View>}

      {pendingThrow ? <View style={styles.pendingThrow}>
        <Text style={styles.latestEyebrow}>THROW {score + 1} · READY TO SAVE</Text>
        <Text style={styles.latestText}>{[[pendingThrow.disc || 'No disc', pendingThrow.type === 'Putt' ? null : pendingThrow.style.toLowerCase(), pendingThrow.type.toLowerCase()].filter(Boolean).join(' '), formatLie(pendingThrow.lie), pendingThrow.quality ? `quality ${pendingThrow.quality}/${QUALITY_MAX}` : null].filter(Boolean).join(' · ')}</Text>
        {saveStatus.kind === 'error' ? <Text style={styles.gpsWarning}>{saveStatus.message}</Text> : null}
        {saveStatus.kind === 'poor' ? <>
          <Text style={styles.gpsWarning}>GPS is only accurate to about {saveStatus.accuracy} m here, so this throw’s distance may be off. Wait a few seconds and try again, away from trees if you can, or save it anyway.</Text>
          <View style={styles.pendingActions}>
            <HoldPressable onPress={() => savePendingThrow()} style={[styles.endSessionButton, styles.pendingAction]} accessibilityRole="button"><Text style={styles.undoText}>TRY AGAIN</Text></HoldPressable>
            <HoldPressable onPress={() => savePendingThrow(true)} style={[styles.endSessionButton, styles.pendingAction, styles.saveButton]} accessibilityRole="button"><Text style={styles.saveButtonText}>SAVE ANYWAY</Text></HoldPressable>
          </View>
        </> : <HoldPressable onPress={() => savePendingThrow()} disabled={saveStatus.kind === 'saving'} style={[styles.logThrowButton, saveStatus.kind === 'saving' && styles.disabledButton]} accessibilityRole="button">
          <Text style={styles.logThrowButtonText}>{saveStatus.kind === 'saving' ? 'GETTING GPS…' : 'SAVE LOCATION ✓'}</Text>
          <Text style={styles.logThrowButtonHint}>Stand at your disc, then press and hold{gpsAccuracy === null ? '' : `  ·  GPS ±${gpsAccuracy} m`}</Text>
        </HoldPressable>}
        <View style={styles.pendingActions}>
          <HoldPressable onPress={() => setLogging(pendingThrow)} disabled={saveStatus.kind === 'saving'} style={[styles.endSessionButton, styles.pendingAction]} accessibilityRole="button"><Text style={styles.undoText}>EDIT</Text></HoldPressable>
          <HoldPressable onPress={discardPendingThrow} disabled={saveStatus.kind === 'saving'} style={[styles.endSessionButton, styles.pendingAction]} accessibilityRole="button"><Text style={styles.undoText}>CANCEL THROW</Text></HoldPressable>
        </View>
      </View> : <HoldPressable onPress={startLogThrow} style={styles.logThrowButton} accessibilityRole="button"><Text style={styles.logThrowButtonText}>LOG THROW {score + 1}</Text><Text style={styles.logThrowButtonHint}>Press and hold to enter the throw</Text></HoldPressable>}
      {roundMessage ? <Text style={styles.gpsMessage}>{roundMessage}</Text> : null}

      <View style={styles.latestRow}>
        <HoldPressable onPress={() => latestShot && setEditingThrow({ sessionId: ACTIVE_SESSION_ID, index: shots.indexOf(latestShot) })} disabled={!latestShot} style={styles.latestCopy} accessibilityRole="button" accessibilityHint="Opens the throw to change its details"><Text style={styles.latestEyebrow}>LATEST THROW{latestShot ? '  ·  HOLD TO EDIT' : ''}</Text><Text style={styles.latestText}>{latestShot ? [latestShot.feet ? `${latestShot.feet} ft` : 'Distance n/a', [latestShot.disc || 'No disc', latestShot.style?.toLowerCase(), latestShot.type.toLowerCase()].filter(Boolean).join(' '), formatLie(latestShot.lie), latestShot.quality ? `quality ${formatQuality(latestShot)}` : null].filter(Boolean).join(' · ') : 'No throws on this hole yet'}</Text></HoldPressable>
        {activeShots.length > 0 && <HoldPressable accessibilityLabel="Undo last throw" onPress={undoLastThrow} style={styles.undoButton}><Text style={styles.undoText}>UNDO</Text></HoldPressable>}
      </View>
      <HoldPressable onPress={finishHole} style={styles.finishButton}><Text style={styles.finishButtonText}>{mode === 'Practice' ? 'NEXT TARGET' : 'FINISH HOLE'} <Text style={styles.finishArrow}>↗</Text></Text></HoldPressable>
      <HoldPressable onPress={endSession} style={styles.endSessionButton} accessibilityRole="button"><Text style={styles.endSessionText}>END {mode === 'Round' ? 'ROUND' : 'PRACTICE'}</Text></HoldPressable>
      <HoldPressable onPress={() => setDimRound((current) => !current)} style={styles.endSessionButton} accessibilityRole="switch" accessibilityLabel="Dim the screen during rounds" accessibilityState={{ checked: dimRound }}><Text style={styles.dimToggleText}>SCREEN DIMMING: {dimRound ? 'ON' : 'OFF'}</Text></HoldPressable>
      {selectedCourse ? <View style={styles.roundCourseInfo}>
        <HoldPressable onPress={() => setShowCourseInfo((current) => !current)} style={styles.roundCourseInfoHeader} accessibilityRole="button" accessibilityState={{ expanded: showCourseInfo }}>
          <Text style={styles.sectionTitle}>Course info</Text><Text style={styles.menuArrow}>{showCourseInfo ? '−' : '+'}</Text>
        </HoldPressable>
        {showCourseInfo && <>
          {selectedCourseStats && <Text style={styles.roundCourseInfoText}>{[
            `${selectedCourseStats.holes} ${selectedCourseStats.holes === 1 ? 'hole' : 'holes'}`,
            selectedCourseStats.parHoles ? `Par ${selectedCourseStats.par}` : null,
            selectedCourseStats.mappedHoles ? `${selectedCourseStats.distanceFeet.toLocaleString()} ft` : null,
            selectedCourseStats.elevationFeet === null ? null : `${selectedCourseStats.elevationFeet} ft elevation change`,
          ].filter(Boolean).join(' · ')}</Text>}
          {courseAddressLine(selectedCourse) ? <Text style={styles.roundCourseInfoText}>{courseAddressLine(selectedCourse)}</Text> : null}
          {selectedCourse.phone?.trim() ? <Text style={styles.roundCourseInfoText}>{selectedCourse.phone}</Text> : null}
          {selectedCourse.notes?.trim() ? <><Text style={[styles.fieldLabel, styles.roundCourseNotesLabel]}>INFO TO KNOW</Text><Text style={styles.roundCourseNotes}>{selectedCourse.notes.trim()}</Text></> : null}
          <CourseLinks course={selectedCourse} />
        </>}
      </View> : null}
      <Text style={styles.footnote}>{selectedHoleLayout?.tee ? 'Distances are measured by GPS from the tee or your previous lie.' : 'Map this hole’s tee in Course builder to measure your first throw. Later throws are measured from your previous lie.'}</Text>
    </ScrollView>

    {logging && <LogThrowSheet
      throwNumber={score + 1}
      initial={logging}
      bag={bag}
      onNext={confirmDetails}
      lastHole={hole >= (selectedCourse?.holes ?? 18)}
      onCancel={() => setLogging(null)}
    />}
    {editingThrow && <ThrowEditorSheet target={editingThrow} layouts={selectedCourse?.layouts} hold onClose={() => setEditingThrow(null)} />}
  </>;
};
