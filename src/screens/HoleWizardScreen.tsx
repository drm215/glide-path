import * as Location from 'expo-location';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { GpsPoint } from '../../lib/types';
import { styles } from '../theme';
import { PAR_OPTIONS } from '../constants';
import { formatElevation, formatSavedPoint } from '../format';
import { holeDistanceFeet, holeElevationFeet, MAP_SCALE_BAR_OPTIONS_FEET, MAP_VIEW_WIDTH_FEET, type MapRegion, METERS_PER_DEGREE, regionAtPoint } from '../geo';
import { BasketCircles } from '../components/BasketCircles';
import { COURSES_BACK, NEW_COURSE_BACK, ScreenHeading } from '../components/ScreenHeading';
import { backTo } from '../navigation';
import { useApp } from '../state/AppState';

export const HoleWizardScreen = () => {
  const { addHoleToCourse, deleteHole, fullHoleLayouts, hasMultipleLayouts, locationAllowed, selectedCourse, setHolePar, setLocationAllowed, updateCourseLayout } = useApp();
  // Opened from the new-course flow (?from=new) or Course builder; FINISH goes back there.
  const { from } = useLocalSearchParams<{ from?: string }>();
  const returnTo = from === 'new' ? 'NewCourse' : 'CourseBuilder';
  const [builderHole, setBuilderHole] = useState(1);
  const [savingGpsTarget, setSavingGpsTarget] = useState<'tee' | 'basket' | null>(null);
  // The screen opens by finding the player (see the effect below).
  const [gpsMessage, setGpsMessage] = useState('Finding your location…');
  const [mapRegion, setMapRegion] = useState<MapRegion | null>(null);
  const [mapViewportWidth, setMapViewportWidth] = useState(0);
  const [mapLoading, setMapLoading] = useState(true);

  const editorHoleLayout = selectedCourse?.layouts?.[builderHole - 1];
  const mappedHoleCount = selectedCourse?.layouts?.filter((layout) => layout.tee && layout.basket).length ?? 0;
  const visibleMapWidthFeet = mapRegion
    ? (mapRegion.longitudeDelta * METERS_PER_DEGREE * Math.cos((mapRegion.latitude * Math.PI) / 180)) / 0.3048
    : MAP_VIEW_WIDTH_FEET;
  const scaleBarFeet = [...MAP_SCALE_BAR_OPTIONS_FEET].reverse().find((feet) => feet <= visibleMapWidthFeet * 0.4) ?? MAP_SCALE_BAR_OPTIONS_FEET[0];
  const scaleBarWidth = mapViewportWidth > 0
    ? Math.min(mapViewportWidth * 0.7, (scaleBarFeet / Math.max(1, visibleMapWidthFeet)) * mapViewportWidth)
    : 52;
  const editorHoleDistance = holeDistanceFeet(editorHoleLayout);

  const moveWizardHole = async (nextHole: number, isNewHole = false) => {
    if (!selectedCourse || nextHole < 1 || (!isNewHole && nextHole > selectedCourse.holes)) return;
    setBuilderHole(nextHole);
    setGpsMessage('');
    const savedPoint = selectedCourse.layouts?.[nextHole - 1]?.tee ?? selectedCourse.layouts?.[nextHole - 1]?.basket;
    if (savedPoint) {
      setMapRegion(regionAtPoint(savedPoint));
      return;
    }
    if (!locationAllowed) return;
    try {
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setMapRegion(regionAtPoint(fix.coords));
    } catch {
      setGpsMessage('Use Recenter to locate this hole on the satellite map.');
    }
  };

  const recenterSatelliteMap = async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        setGpsMessage('Location access is needed to recenter the map.');
        return;
      }
      setLocationAllowed(true);
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setMapRegion(regionAtPoint(fix.coords));
      setGpsMessage('');
    } catch {
      setGpsMessage('Could not find your location. Try again outdoors.');
    }
  };

  const saveCoursePoint = async (target: 'tee' | 'basket') => {
    if (!selectedCourse || savingGpsTarget) return;
    const courseId = selectedCourse.id;
    const layoutId = selectedCourse.layoutId;
    const targetHole = builderHole;
    setSavingGpsTarget(target);
    setGpsMessage('Waiting for a GPS fix…');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        setGpsMessage(permission.canAskAgain ? 'Location permission is needed to save this point.' : 'Enable location access for Glide Path in Settings, then try again.');
        return;
      }
      setLocationAllowed(true);
      if (!(await Location.hasServicesEnabledAsync())) {
        setGpsMessage('Turn on Location Services, then save this point again.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: true });
      const point: GpsPoint = {
        latitude: fix.coords.latitude,
        longitude: fix.coords.longitude,
        accuracy: fix.coords.accuracy,
        timestamp: fix.timestamp,
        altitude: fix.coords.altitude,
        altitudeAccuracy: fix.coords.altitudeAccuracy,
      };
      setMapRegion(regionAtPoint(point));
      updateCourseLayout(courseId, layoutId, (layout) => {
        const layouts = fullHoleLayouts(layout);
        layouts[targetHole - 1] = { ...(layouts[targetHole - 1] ?? { tee: null, basket: null }), [target]: point };
        return { ...layout, layouts };
      });
      const accuracyText = point.accuracy === null ? 'accuracy unavailable' : `accuracy ±${Math.round(point.accuracy)} m`;
      setGpsMessage(`${target === 'tee' ? 'Tee box' : 'Basket'} saved · ${accuracyText}${point.accuracy !== null && point.accuracy > 25 ? '. GPS is weak; wait a moment and save again for a better fix.' : '.'}`);
    } catch {
      setGpsMessage('Could not get a GPS fix. Move outdoors, wait briefly, and try again.');
    } finally {
      setSavingGpsTarget(null);
    }
  };

  const addWizardHole = () => {
    if (!selectedCourse) return;
    const newHole = selectedCourse.holes + 1;
    addHoleToCourse(selectedCourse.id);
    moveWizardHole(newHole, true);
  };

  // Opening the screen centers the map on the player, or on the first hole's saved point. Runs
  // once, for the course and layout the screen was opened on.
  useEffect(() => {
    const course = selectedCourse;
    if (!course) return;
    let left = false;
    const showSavedPoint = () => {
      const savedPoint = course.layouts?.[0]?.tee ?? course.layouts?.[0]?.basket;
      if (savedPoint) setMapRegion(regionAtPoint(savedPoint));
    };
    (async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (left) return;
        setLocationAllowed(permission.status === 'granted');
        if (permission.status !== 'granted') {
          showSavedPoint();
          setGpsMessage(permission.canAskAgain ? 'Allow location access to center the satellite map and save hole points.' : 'Enable location access in Settings to map a new hole.');
          return;
        }
        const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (left) return;
        setMapRegion(regionAtPoint(fix.coords));
        setGpsMessage('');
      } catch {
        if (left) return;
        showSavedPoint();
        setGpsMessage('Could not find your location. Try again outdoors.');
      } finally {
        if (!left) setMapLoading(false);
      }
    })();
    return () => {
      left = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>
    <ScreenHeading eyebrow={`${selectedCourse?.name ?? 'COURSE'}${hasMultipleLayouts ? ` · ${selectedCourse?.layoutLabel}` : ''} · SATELLITE MAP`} title={`Hole ${String(builderHole).padStart(2, '0')}.`} back={returnTo === 'NewCourse' ? NEW_COURSE_BACK : COURSES_BACK} />
    <View style={styles.holeWizard}>
      <View style={styles.wizardProgress}><View><Text style={styles.editorHoleName}>HOLE {String(builderHole).padStart(2, '0')} OF {String(selectedCourse?.holes ?? 0).padStart(2, '0')}</Text><Text style={[styles.mapProgress, styles.wizardMappedCount]}>{mappedHoleCount}/{selectedCourse?.holes ?? 0} MAPPED</Text></View>{selectedCourse && <Pressable onPress={() => deleteHole(selectedCourse, builderHole, () => setBuilderHole(Math.max(1, builderHole - 1)))} accessibilityRole="button" accessibilityLabel={`Delete hole ${builderHole}`} style={styles.deleteHoleButton}><Text style={styles.deleteButtonText}>DELETE HOLE</Text></Pressable>}</View>
      <View style={styles.satelliteFrame} onLayout={(event) => setMapViewportWidth(event.nativeEvent.layout.width)}>
        {mapRegion ? <MapView style={styles.satelliteMap} mapType="satellite" region={mapRegion} onRegionChangeComplete={setMapRegion} showsUserLocation={locationAllowed} showsMyLocationButton={false}>
          {editorHoleLayout?.tee && <Marker coordinate={editorHoleLayout.tee} title={`Hole ${builderHole} tee box`} description={`GPS accuracy ${editorHoleLayout.tee.accuracy ?? 'unknown'} meters`} pinColor="#1d684c" />}
          {editorHoleLayout?.basket && <BasketCircles basket={editorHoleLayout.basket} />}
          {editorHoleLayout?.basket && <Marker coordinate={editorHoleLayout.basket} title={`Hole ${builderHole} basket`} description={`GPS accuracy ${editorHoleLayout.basket.accuracy ?? 'unknown'} meters`} pinColor="#d77d42" />}
          {editorHoleLayout?.tee && editorHoleLayout.basket && <Polyline coordinates={[editorHoleLayout.tee, editorHoleLayout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
        </MapView> : <View style={styles.mapUnavailable}><Text style={styles.mapUnavailableTitle}>{mapLoading ? 'Finding your location…' : 'Map location unavailable'}</Text><Text style={styles.mapUnavailableText}>{gpsMessage || 'Enable location access to open the satellite map.'}</Text><Pressable onPress={recenterSatelliteMap} style={styles.recenterButton}><Text style={styles.recenterButtonText}>TRY AGAIN</Text></Pressable></View>}
        {mapRegion && <><View pointerEvents="none" style={styles.satelliteBadge}><Text style={styles.satelliteBadgeText}>SATELLITE</Text></View><Pressable onPress={recenterSatelliteMap} style={styles.recenterButton}><Text style={styles.recenterButtonText}>◎ RECENTER</Text></Pressable><View pointerEvents="none" style={styles.mapScaleBadge}><View style={[styles.mapScaleRule, { width: scaleBarWidth }]} /><Text style={styles.mapScaleLabel}>{scaleBarFeet} FT</Text><Text style={styles.mapScaleWidth}>VIEW ≈{Math.round(visibleMapWidthFeet)} FT WIDE</Text></View></>}
      </View>
      <Text style={styles.mapInstruction}>Walk to each point. Save your GPS position when the blue location dot is at the tee or basket.</Text>
      <View style={styles.captureButtons}>
        <Pressable onPress={() => saveCoursePoint('tee')} disabled={savingGpsTarget !== null} style={[styles.captureButton, editorHoleLayout?.tee && styles.captureButtonSaved, savingGpsTarget === 'tee' && styles.disabledButton]}><Text style={styles.captureButtonLabel}>TEE BOX</Text><Text style={styles.captureButtonValue}>{savingGpsTarget === 'tee' ? 'SAVING GPS…' : editorHoleLayout?.tee ? 'UPDATE LOCATION' : 'SAVE LOCATION'}</Text><Text style={styles.captureButtonCoords}>{formatSavedPoint(editorHoleLayout?.tee)}</Text></Pressable>
        <Pressable onPress={() => saveCoursePoint('basket')} disabled={savingGpsTarget !== null} style={[styles.captureButton, editorHoleLayout?.basket && styles.captureButtonSaved, savingGpsTarget === 'basket' && styles.disabledButton]}><Text style={styles.captureButtonLabel}>BASKET</Text><Text style={styles.captureButtonValue}>{savingGpsTarget === 'basket' ? 'SAVING GPS…' : editorHoleLayout?.basket ? 'UPDATE LOCATION' : 'SAVE LOCATION'}</Text><Text style={styles.captureButtonCoords}>{formatSavedPoint(editorHoleLayout?.basket)}</Text></Pressable>
      </View>
      <View style={styles.parPicker}>
        <Text style={styles.holeDistanceLabel}>PAR</Text>
        <View style={styles.parOptions}>
          {PAR_OPTIONS.map((value) => <Pressable key={value} onPress={() => setHolePar(value, builderHole)} style={[styles.parOption, editorHoleLayout?.par === value && styles.parOptionSelected]} accessibilityRole="button" accessibilityLabel={`Par ${value}`}><Text style={[styles.parOptionText, editorHoleLayout?.par === value && styles.parOptionTextSelected]}>{value}</Text></Pressable>)}
        </View>
      </View>
      {editorHoleDistance !== null && <View style={styles.holeDistance}><Text style={styles.holeDistanceLabel}>TEE TO BASKET</Text><Text style={styles.holeDistanceValue}>{editorHoleDistance} ft{holeElevationFeet(editorHoleLayout) === null ? '' : `  ${formatElevation(holeElevationFeet(editorHoleLayout)!)}`}</Text></View>}
      {gpsMessage ? <Text style={styles.gpsMessage}>{gpsMessage}</Text> : null}
      <View style={styles.wizardNavigation}>
        <Pressable onPress={() => moveWizardHole(builderHole - 1)} disabled={builderHole === 1} style={[styles.wizardNavButton, builderHole === 1 && styles.holeNavDisabled]}><Text style={styles.wizardNavText}>‹ PREVIOUS</Text></Pressable>
        <Pressable onPress={() => backTo(returnTo)} style={[styles.wizardNavButton, styles.wizardNavFinish]}><Text style={styles.wizardNavFinishText}>FINISH ✓</Text></Pressable>
        <Pressable onPress={() => builderHole < (selectedCourse?.holes ?? 1) ? moveWizardHole(builderHole + 1) : addWizardHole()} style={[styles.wizardNavButton, styles.wizardNavNext]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>{builderHole < (selectedCourse?.holes ?? 1) ? 'NEXT HOLE ›' : '+ ADD HOLE'}</Text></Pressable>
      </View>
    </View>
  </>;
};
