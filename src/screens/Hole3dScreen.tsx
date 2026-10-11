import { useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { API_URL } from '../../lib/api';
import { withExistingLayout } from '../../lib/layouts';
import { formatSessionDate } from '../format';
import { holeVisits } from '../holeHistory';
import { PREVIOUS_BACK, ScreenHeading } from '../components/ScreenHeading';
import { useApp } from '../state/AppState';
import { styles } from '../theme';

// One hole in 3D (/hole3d?course=&layout=&hole=, with round=<id> to show that round first and
// practice=1 to include practice sessions). The website's /3d page draws it, the same view as on
// the website's round pages; this screen hands it the hole and its throws once it's ready.
export const Hole3dScreen = () => {
  const { courses, history } = useApp();
  const params = useLocalSearchParams<{ course: string; layout: string; hole: string; round?: string; practice?: string }>();
  const webView = useRef<WebView>(null);
  const [failed, setFailed] = useState(false);
  const hole = Number(params.hole);
  const baseCourse = courses.find((course) => course.id === params.course);
  const layout = (baseCourse ? withExistingLayout(baseCourse, params.layout) : undefined)?.layouts?.[hole - 1] ?? null;
  const visits = holeVisits(history, params.course, params.layout, hole, params.practice === '1');
  const hole3d = {
    hole,
    layout,
    rounds: visits.map(({ session, shots }) => ({ id: session.id, label: `${formatSessionDate(session)}${session.mode === 'Practice' ? ' (practice)' : ''}`, shots })),
    selected: params.round ? [params.round] : [],
  };

  const onMessage = (event: WebViewMessageEvent) => {
    if (event.nativeEvent.data === 'ready') webView.current?.postMessage(JSON.stringify({ type: 'hole3d', hole3d }));
  };

  return <>
    <ScreenHeading eyebrow={`${(baseCourse?.name ?? 'COURSE').toUpperCase()} · 3D`} title={`Hole ${String(hole).padStart(2, '0')}.`} back={PREVIOUS_BACK} />
    {failed
      ? <Text style={[styles.mapInstruction, styles.content]}>The 3D view needs a connection to load the map and terrain. Try again when you’re online.</Text>
      : <View style={styles.webViewFrame}>
        <WebView
          ref={webView}
          source={{ uri: `${API_URL}/3d?theme=dark` }}
          onMessage={onMessage}
          onError={() => setFailed(true)}
          onHttpError={() => setFailed(true)}
          style={styles.webView}
          originWhitelist={[API_URL]}
          accessibilityLabel={`3D view of hole ${hole}`}
        />
      </View>}
  </>;
};
