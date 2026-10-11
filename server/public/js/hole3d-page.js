// The /3d page shown inside the app: it asks the app for a hole (posting 'ready'), then draws the
// message it gets back, { type: 'hole3d', hole3d: renderHole3d options }. ?theme=dark matches
// the app's dark theme.
import { renderHole3d } from './hole3d.js';

if (new URLSearchParams(location.search).get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

const root = document.getElementById('hole3d');
let view = null;

const receive = (event) => {
  let message = event.data;
  try {
    if (typeof message === 'string') message = JSON.parse(message);
  } catch {
    return;
  }
  if (message?.type !== 'hole3d') return;
  view?.destroy();
  view = renderHole3d(root, message.hole3d);
};

// The app's WebView delivers messages to window on iOS and to document on Android.
window.addEventListener('message', receive);
document.addEventListener('message', receive);
window.ReactNativeWebView?.postMessage('ready');
