import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import * as Brightness from 'expo-brightness';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Modal, ScrollView, Text, View } from 'react-native';
import { guessDisc, guessThrowType, suggestDiscs } from '../../lib/rounds';
import type { Disc, Lie, Shot, ThrowStyle, ThrowType } from '../../lib/types';
import { styles } from '../theme';
import { ACTIVE_SESSION_ID, GPS_GOOD_ACCURACY_M, GPS_POOR_ACCURACY_M, lieLabel, lieOptionsFor, QUALITY_MAX, QUALITY_OPTIONS, ROUND_BRIGHTNESS, ROUND_KEEP_AWAKE_TAG, STYLE_OPTIONS, TYPE_OPTIONS, WARM_FIX_MAX_AGE_MS } from '../constants';
import { nowMs } from '../time';
import { courseAddressLine, formatElevation, formatLie, formatQuality, formatScoreToPar, formatThrowDetail } from '../format';
import { courseStats, feetBetween, holeDistanceFeet, holeElevationFeet, regionAtPoint, regionForHole } from '../geo';
import { countStrokes, nextThrowType, scoreSummary } from '../scoring';
import { HoldPressable } from '../components/HoldPressable';
import { BasketCircles } from '../components/BasketCircles';
import { ScreenHeading } from '../components/ScreenHeading';
import { CourseLinks } from '../components/CourseLinks';
import { ThrowEditorSheet, type ThrowTarget } from '../components/ThrowEditorSheet';
import { useApp } from '../state/AppState';

export const RoundScreen = () => {
  const { bag, bagDetails, dimRound, disc, finishSession, hasMultipleLayouts, history, hole, locationAllowed, mode, practiceFocus, roundMessage, selectedCourse, setDimRound, setDisc, setHole, setLocationAllowed, setRoundMessage, setShots, setThrowStyle, shots, throwStyle, navigate } = useApp();
  const [throwType, setThrowType] = useState<ThrowType>('Drive');
  const [loggingThrow, setLoggingThrow] = useState(false);
  const [pendingLie, setPendingLie] = useState<{ latitude: number; longitude: number; altitude: number | null; accuracy: number | null; feet: number } | null>(null);
  const [logStep, setLogStep] = useState<1 | 2 | 3 | 4>(1);
  const [throwLie, setThrowLie] = useState<Lie>('Fairway');
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

  // While a round is open, keep the screen on. Keep-awake is a nicety; the round works without it.
  useEffect(() => {
    activateKeepAwakeAsync(ROUND_KEEP_AWAKE_TAG).catch(() => undefined);
    return () => {
      Promise.resolve(deactivateKeepAwake(ROUND_KEEP_AWAKE_TAG)).catch(() => undefined);
    };
  }, []);

  // With dimming on, the round screen saves battery by lowering brightness (never raising it), and
  // restores it on the way out. iOS restores brightness itself when the phone locks, so dim again on
  // return. Players turn dimming off when the screen is too dark to read in the sun.
  useEffect(() => {
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
  }, [dimRound]);

  // While the round screen is open, keep a GPS fix warm so logging a throw is instant and as
  // accurate as the phone can manage, rather than waiting on a single cold reading.
  useEffect(() => {
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
  }, [locationAllowed]);


  const activeShots = shots.filter((shot) => shot.hole === hole);
  const score = activeShots.length;
  const holeStrokes = countStrokes(activeShots);
  const holeFeet = activeShots.reduce((total, shot) => total + shot.feet, 0);
  const allShots = [...history.flatMap((session) => session.shots), ...shots];

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
  const caddie = caddieTargetFeet === null ? [] : suggestDiscs(caddieTargetFeet, caddieType, allShots, bag);
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

  // Reads the GPS position at the disc. Reports progress and problems through `report`.
  const captureLie = async (report: (message: string) => void) => {
    report('Getting a GPS fix at your lie…');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        report(permission.canAskAgain ? 'Location permission is needed to log where your disc landed.' : 'Enable location access for Glide Path in Settings, then try again.');
        return null;
      }
      setLocationAllowed(true);
      if (!(await Location.hasServicesEnabledAsync())) {
        report('Turn on Location Services, then log the throw again.');
        return null;
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
      return { ...lie, altitude: fix.coords.altitude, accuracy: fix.coords.accuracy, feet: previous ? Math.max(1, Math.round(feetBetween(previous, lie))) : 0 };
    } catch {
      report('Could not get a GPS fix. Wait a moment and try again.');
      return null;
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
    const suggested = from && basket ? suggestDiscs(Math.round(feetBetween(from, basket)), type, recent, bag, 1)[0]?.disc : undefined;
    return { type, disc: suggested ?? guessDisc(type, recent, bag, bagDetails, disc) };
  };

  // Adds a throw to the round in progress. Returns a short description for confirmations.
  const recordThrow = (point: { latitude: number; longitude: number; altitude: number | null; accuracy: number | null; feet: number }, details: { type: ThrowType; disc: Disc; style: ThrowStyle; lie: Lie; quality: number | null }) => {
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
    setThrowType(details.type === 'Putt' ? 'Putt' : 'Approach');
    const summary = `Throw ${score + 1} · ${formatThrowDetail(shot)}`;
    if (details.lie !== 'Basket') return summary;
    // A made basket finishes the hole.
    const throwCount = holeStrokes + 1;
    const holeCount = selectedCourse?.holes ?? 18;
    setThrowLie('Fairway');
    if (hole >= holeCount) {
      setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. That was the last hole.`);
      promptLastHoleComplete();
      return `Hole ${hole} complete in ${throwCount}. That was the last hole.`;
    }
    setHole(hole + 1);
    setThrowType('Drive');
    setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. On to hole ${hole + 1}.`);
    return `Hole ${hole} complete in ${throwCount}. On to hole ${hole + 1}.`;
  };

  // Captures the player's GPS position at the disc, then asks for disc, throw type and quality,
  // starting from the best guesses.
  const startLogThrow = async () => {
    if (loggingThrow) return;
    setLoggingThrow(true);
    const point = await captureLie(setRoundMessage);
    setLoggingThrow(false);
    if (!point) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      return;
    }
    const guess = guessThrow();
    setThrowType(guess.type);
    setDisc(guess.disc);
    setThrowLie(guess.type === 'Putt' ? 'Missed' : 'Fairway');
    setPendingLie(point);
    setLogStep(1);
    setRoundMessage('');
  };

  const cancelLogThrow = () => setPendingLie(null);

  // `quality` is null when the throw is saved without a rating.
  const saveThrow = (quality: number | null, lie: Lie = throwLie) => {
    if (!pendingLie) return;
    recordThrow(pendingLie, { type: throwType, disc, style: throwStyle, lie, quality });
    setPendingLie(null);
  };


  const startNextHole = () => {
    setHole((current) => (current >= (selectedCourse?.holes ?? 18) ? 1 : current + 1));
    setThrowType('Drive');
    navigate('Round');
  };

  const goToPreviousHole = () => {
    if (hole <= 1) return;
    const previousHole = hole - 1;
    setHole(previousHole);
    setThrowType(nextThrowType(shots.filter((shot) => shot.hole === previousHole)));
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

      <HoldPressable onPress={startLogThrow} disabled={loggingThrow} style={[styles.logThrowButton, loggingThrow && styles.disabledButton]} accessibilityRole="button"><Text style={styles.logThrowButtonText}>{loggingThrow ? 'GETTING GPS…' : `LOG THROW ${score + 1}`}</Text><Text style={styles.logThrowButtonHint}>Stand where your disc landed, then press and hold{gpsAccuracy === null ? '' : `  ·  GPS ±${gpsAccuracy} m`}</Text></HoldPressable>
      {roundMessage ? <Text style={styles.gpsMessage}>{roundMessage}</Text> : null}

      <View style={styles.latestRow}>
        <HoldPressable onPress={() => latestShot && setEditingThrow({ sessionId: ACTIVE_SESSION_ID, index: shots.indexOf(latestShot) })} disabled={!latestShot} style={styles.latestCopy} accessibilityRole="button" accessibilityHint="Opens the throw to change its details"><Text style={styles.latestEyebrow}>LATEST THROW{latestShot ? '  ·  HOLD TO EDIT' : ''}</Text><Text style={styles.latestText}>{latestShot ? [latestShot.feet ? `${latestShot.feet} ft` : 'Distance n/a', [latestShot.disc || 'No disc', latestShot.style?.toLowerCase(), latestShot.type.toLowerCase()].filter(Boolean).join(' '), formatLie(latestShot.lie), latestShot.quality ? `quality ${formatQuality(latestShot)}` : null].filter(Boolean).join(' · ') : 'Walk to your disc and hold Log throw'}</Text></HoldPressable>
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

    <Modal visible={pendingLie !== null} transparent animationType="slide" onRequestClose={cancelLogThrow}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.controlHeading}><Text style={styles.controlTitle}>Log throw {score + 1}</Text><Text style={styles.controlStep}>0{logStep} / 04</Text></View>
          <Text style={styles.sheetDistance}>{pendingLie?.feet ? `${pendingLie.feet} ft from ${activeShots.some((shot) => shot.latitude !== undefined) ? 'your previous lie' : 'the tee'}` : 'Distance unavailable: this hole’s tee is not mapped'}{pendingLie?.accuracy == null ? '' : `  ·  GPS ±${Math.round(pendingLie.accuracy)} m`}</Text>
          {pendingLie?.accuracy != null && pendingLie.accuracy > GPS_POOR_ACCURACY_M && <Text style={styles.gpsWarning}>GPS is only accurate to about {Math.round(pendingLie.accuracy)} m here, so this distance may be off. For a better reading, cancel and log the throw again in a few seconds, away from trees if you can.</Text>}
          {logStep === 1 ? <>
            <Text style={styles.fieldLabel}>WHICH DISC?</Text>
            <View style={styles.sheetOptions}>
              {bag.map((item, index) => <HoldPressable key={`${item}-${index}`} onPress={() => { setDisc(item); setLogStep(2); }} style={[styles.chip, styles.sheetChip, disc === item && styles.chipSelected]}><Text style={[styles.chipText, disc === item && styles.chipTextSelected]}>{item}</Text></HoldPressable>)}
              {!bag.length && <HoldPressable onPress={() => { setDisc(''); setLogStep(2); }} style={[styles.chip, styles.sheetChip]}><Text style={styles.chipText}>No disc (bag is empty)</Text></HoldPressable>}
            </View>
          </> : logStep === 2 ? <>
            <Text style={styles.fieldLabel}>TYPE OF THROW</Text>
            <View style={styles.typeRow}>
              {TYPE_OPTIONS.map((item) => <HoldPressable key={item} onPress={() => setThrowType(item)} style={[styles.typeButton, styles.sheetTypeButton, throwType === item && styles.typeButtonSelected]} accessibilityState={{ selected: throwType === item }}><Text style={[styles.typeText, throwType === item && styles.typeTextSelected]}>{item}</Text></HoldPressable>)}
            </View>
            <Text style={[styles.fieldLabel, styles.typeLabel]}>HOW DID YOU THROW IT?</Text>
            <View style={[styles.typeRow, styles.lieGrid]}>
              {STYLE_OPTIONS.map((item) => <HoldPressable key={item} onPress={() => { setThrowStyle(item); setLogStep(3); }} style={[styles.typeButton, styles.sheetTypeButton, styles.styleButton, throwStyle === item && styles.typeButtonSelected]}><Text style={[styles.typeText, throwStyle === item && styles.typeTextSelected]}>{item}</Text></HoldPressable>)}
            </View>
          </> : logStep === 3 ? <>
            <Text style={styles.fieldLabel}>{throwType === 'Putt' ? 'PUTT RESULT' : 'WHERE DID IT LAND?'}</Text>
            <View style={[styles.typeRow, styles.lieGrid]}>
              {lieOptionsFor(throwType).map((item) => <HoldPressable key={item} onPress={() => { if (item === 'Basket') { saveThrow(QUALITY_MAX, 'Basket'); return; } setThrowLie(item); setLogStep(4); }} style={[styles.typeButton, styles.sheetTypeButton, styles.lieButton, item === 'OB' && styles.obButton, throwLie === item && styles.typeButtonSelected]} accessibilityLabel={item === 'OB' ? 'Out of bounds, one penalty stroke' : lieLabel(item, throwType)}><Text style={[styles.typeText, item === 'OB' && styles.obText, throwLie === item && styles.typeTextSelected]}>{lieLabel(item, throwType)}</Text>{item === 'OB' && <Text style={styles.obPenaltyText}>+1 STROKE</Text>}</HoldPressable>)}
            </View>
          </> : <>
            <Text style={styles.fieldLabel}>HOW WAS THE THROW?</Text>
            <View style={styles.typeRow}>
              {QUALITY_OPTIONS.map((option) => <HoldPressable key={option.value} onPress={() => saveThrow(option.value)} style={[styles.typeButton, styles.qualityButton]} accessibilityLabel={`Quality ${option.value}, ${option.label}`}><Text style={styles.qualityValue}>{option.value}</Text><Text style={styles.qualityLabel}>{option.label}</Text></HoldPressable>)}
            </View>
          </>}
          <View style={styles.editFooter}>
            {logStep > 1 ? <HoldPressable onPress={() => setLogStep(logStep === 4 ? 3 : logStep === 3 ? 2 : 1)} style={styles.sheetFooterButton}><Text style={styles.undoText}>‹ BACK</Text></HoldPressable> : <View />}
            <View style={styles.editFooterActions}>
              <HoldPressable onPress={cancelLogThrow} style={styles.sheetFooterButton}><Text style={styles.undoText}>CANCEL</Text></HoldPressable>
              {/* Saves with the choices so far: the guesses plus anything changed. */}
              <HoldPressable onPress={() => saveThrow(null)} style={[styles.sheetFooterButton, styles.saveButton]} accessibilityLabel={`Save now: ${disc || 'no disc'} ${throwStyle.toLowerCase()} ${throwType.toLowerCase()}, ${throwLie.toLowerCase()}`}><Text style={styles.saveButtonText}>SAVE ✓</Text></HoldPressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
    {editingThrow && <ThrowEditorSheet target={editingThrow} layouts={selectedCourse?.layouts} hold onClose={() => setEditingThrow(null)} />}
  </>;
};
