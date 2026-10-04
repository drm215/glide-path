# Glide Path

An Expo / React Native app for mapping disc golf courses and logging rounds by GPS on iPhone.

## Run locally

```powershell
npx expo start
```

Scan the QR code with the iPhone Camera app to open the project in Expo Go.

## Build for iPhone

Builds run in the cloud with EAS (an Apple Developer account is required):

```powershell
npx eas-cli@latest login
npx eas-cli@latest device:create
npx eas-cli@latest build -p ios --profile preview
```

`eas.json` defines `preview` (internal install on registered devices) and `production` (TestFlight / App Store).

## Features

- **Course builder**: create a course, then map it hole by hole on satellite imagery. Walk to each tee box and basket to save its GPS position (including altitude), set par, and add holes until you tap Finish. Holes can be deleted and pars edited from the course list.
- **Course details**: street, city, state, formatted phone, email, website, and notes, with Directions / Call / Email / Website buttons. Hole count, total par, total distance, and elevation change are calculated from the mapped holes.
- **Bag builder**: search the [DiscIt API](https://github.com/cdleveille/discit-api) as you type and add discs with brand and flight numbers, or add a custom disc by name.
- **Rounds**: walk to where the disc landed and tap Log throw. The app captures GPS, then asks for disc, throw type, landing spot (Fairway, Woods, Hazard, OB, Basket, Other), and quality (1–3). OB adds a penalty stroke; Basket completes the hole and advances. Distances are measured by GPS from the tee or previous lie.
- **Score tracking**: hole score, round score, score to par, and holes completed during play. A round summary with a scorecard appears when the round ends.
- **Round history**: review past rounds with a scorecard, results breakdown, and a per-hole satellite map of where each throw was logged.
- **Resume**: a round in progress survives leaving the screen or closing the app.
- **Practice**: log throws with a distance, accuracy, or putting focus.
- **Account and sync** (optional): sign in from the avatar in the top corner to back up courses, finished rounds, and the bag, and sync them across devices. Sync runs on launch, when the app returns to the foreground, and a few seconds after edits; the app works fully offline.
- **Publish and share**: publish a course to the public directory from Course builder, or share a finished round's scorecard by link from its round detail.
- **Find courses**: search published courses by name, city, or state, or find courses near you, and add them to your courses.

## App code

- `src/app/`: routes (Expo Router). Each file is a screen's URL; `_layout.tsx` holds the brand bar and the navigation stack.
- `src/screens/`: the screens themselves. `src/components/` has pieces several screens share.
- `src/state/AppState.tsx`: shared state, on-phone storage, sync, and the actions screens use (`useApp()`).
- `lib/`: pure logic shared with the server's tests (sync, rounds, layouts, stats).

`npm test` drives the whole app through its main flows with the phone's native features mocked (`test/`).

## Sync server

The `server/` folder holds the API that syncs app data and the website: a public course directory with satellite maps, shared round pages, a signed-in view of your rounds and courses, and the privacy policy. See [server/README.md](server/README.md). It runs at https://glidepathdiscgolf.com (also reachable at glide-path.onrender.com) with its database on a free Neon Postgres project.

The app's sync logic lives in [lib/sync.ts](lib/sync.ts) and is tested against the real API by `server/test/app-sync.test.ts`.

To test the app against a server on your PC instead:

```powershell
cd server; npm run dev:local        # prints the address to use
$env:EXPO_PUBLIC_API_URL="http://<your-PC-address>:3000"; npx expo start
```

## Data and privacy

All data is stored on the device with AsyncStorage and works without an account. When signed in, courses, finished rounds, and the bag are also synced to the Glide Path server; the round in progress syncs once it's finished. The sign-in token is kept in the iOS Keychain. Published courses and shared rounds are public; everything else is private to the account. Location is read only when saving a course point, logging a throw, recentering the map, or finding nearby courses. The network is also used for DiscIt disc searches and map imagery.

Storage keys (`flight-notes-*`) and the Expo slug (`disc-golf-tracker`) keep their original names so data saved before the rename keeps loading; Expo Go separates saved data by slug.

## Known limits

- Without an account, deleting the app deletes its data. Signing in on the installed build is the way to move data from Expo Go to it.
- Sync resolves conflicts per course or round: the most recent edit wins as a whole, so simultaneous edits to different holes of the same course on two devices keep only one device's version.
- Elevation comes from the phone's GPS altitude, which can drift by several meters. Points saved before altitude tracking have no elevation.
- Satellite imagery needs a connection; offline map tiles are not implemented.
- Android builds would need a Google Maps API key and `provider={PROVIDER_GOOGLE}` on the maps.
