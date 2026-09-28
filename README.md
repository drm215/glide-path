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

## Sync server

The `server/` folder holds the API that syncs app data and serves the public course directory; see [server/README.md](server/README.md). `render.yaml` deploys it on Render, with the database on a free Neon Postgres project. The app doesn't use it yet.

## Data and privacy

All data is stored on the device with AsyncStorage; there is no account or server. Location is read only when saving a course point, logging a throw, or recentering the map. The network is used for DiscIt disc searches and map imagery.

Storage keys (`flight-notes-*`) and the Expo slug (`disc-golf-tracker`) keep their original names so data saved before the rename keeps loading; Expo Go separates saved data by slug.

## Known limits

- No export, import, or sync; deleting the app deletes its data. Data entered in Expo Go does not carry over to an installed build.
- Elevation comes from the phone's GPS altitude, which can drift by several meters. Points saved before altitude tracking have no elevation.
- Satellite imagery needs a connection; offline map tiles are not implemented.
- Android builds would need a Google Maps API key and `provider={PROVIDER_GOOGLE}` on the maps.
