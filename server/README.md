# Glide Path API and website

Express + Postgres server that syncs app data, serves the public course directory and shared rounds, and hosts the website.

## Website

Plain HTML, CSS and JavaScript modules with no build step, in `public/`. The only library is [Leaflet](https://leafletjs.com) for maps, served from `node_modules`. The site's own code is about 8 KB gzipped.

| Path | Page |
|---|---|
| `/` | Course search by name, city or state, or near the visitor, with a map of results |
| `/c/:uid` | Published course: details, layouts, hole table, satellite map of tees and baskets |
| `/r/:shareToken` | Shared round: score, scorecard, throw list, per-hole map of throws |
| `/account` | Sign in to see your synced rounds and courses (reads them through `/api/sync`) |
| `/privacy` | Privacy policy |

Course and round pages are rendered on the server, so link previews and no-JS readers get the full content; the browser scripts add the maps from data embedded in the page. Pages send a Content-Security-Policy that only allows the site's own scripts.

Satellite imagery defaults to Esri World Imagery, which Esri permits for non-commercial use with attribution and otherwise expects an ArcGIS account or API key. Set `TILE_URL` (a `{z}/{x}/{y}`-style template, API key included if needed) and `TILE_ATTRIBUTION` to change provider.

## Develop

```powershell
cd server
npm install
npm test          # runs the API against an in-process Postgres (PGlite); no database needed
npm run typecheck
```

To try the app against a server on this PC, run `npm run dev:local`. It uses an embedded Postgres stored in `server/.local-data` and prints the `EXPO_PUBLIC_API_URL` to start Expo with (password reset codes are printed in its terminal); the phone must be on the same Wi-Fi.

To run it against a real database, set `DATABASE_URL` and `AUTH_SECRET`, then `npm run dev`. The schema is created or updated automatically on startup.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `AUTH_SECRET` | Secret for signing sign-in tokens (long random string) |
| `CORS_ORIGIN` | Allowed browser origin; defaults to `*` |
| `RESEND_API_KEY` | Resend API key for password reset emails; without it, password reset reports that it isn't set up |
| `EMAIL_FROM` | Sender for those emails; defaults to `Glide Path <no-reply@glidepathdiscgolf.com>` (its domain must be verified in Resend) |
| `TILE_URL` | Optional satellite tile URL template for the website's maps |
| `TILE_ATTRIBUTION` | Optional attribution text for those tiles |
| `PORT` | Set by Render |

## Deploy

The API runs on Render and the database on a free [Neon](https://neon.com) Postgres project. Render's free databases are deleted after 30 days, while Neon's free tier is permanent (0.5 GB).

1. In Neon, create a project in **AWS US East** (closest to Render's Virginia region) and copy its connection string from **Connect**.
2. In Render, choose **New → Blueprint** and select this repository. `render.yaml` defines the web service; paste the Neon string when asked for `DATABASE_URL`. `AUTH_SECRET` is generated automatically.

Render redeploys on every push to `main`. The free API sleeps after 15 idle minutes and Neon after 5, so the first request after a quiet spell is slow.

## Endpoints

Authenticated endpoints take `Authorization: Bearer <token>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | | Health check |
| POST | `/api/auth/register` | | `{ email, password (8+), displayName }` → `{ token, user }` |
| POST | `/api/auth/login` | | `{ email, password }` → `{ token, user }` |
| POST | `/api/auth/forgot` | | `{ email }` → emails a 6-digit reset code; same answer whether or not the account exists |
| POST | `/api/auth/reset` | | `{ email, code, password }` → `{ token, user }`; codes last 15 minutes, work once, allow 5 guesses |
| GET | `/api/me` | ✓ | Current user |
| DELETE | `/api/me` | ✓ | Delete the account and all its data |
| POST | `/api/sync` | ✓ | Two-way sync (below) |
| GET | `/api/public/courses?q=&near=lat,lng&limit=` | | Search published courses by name/city/state, or sort by distance |
| GET | `/api/public/courses/:uid` | | A published course with hole layouts and details |
| GET | `/api/public/rounds/:shareToken` | | A shared round with its hole layouts |

Sign-in attempts are limited to 20 per 15 minutes per IP address.

## Sync protocol

The app is the source of truth offline. On each sync it sends every record changed since its last successful sync, plus the highest `cursor` it has received (0 on a new device):

```json
{
  "cursor": 0,
  "courses": [{ "clientId": "…", "updatedAt": 1727400000000, "deleted": false, "name": "…", "holes": 18, "layouts": [], "details": {}, "published": false }],
  "rounds": [{ "clientId": "…", "updatedAt": 1727400000000, "deleted": false, "courseClientId": "…", "courseName": "…", "mode": "Round", "shots": [], "shared": false }],
  "bag": { "updatedAt": 1727400000000, "discs": [], "details": {} }
}
```

- `clientId` is the id the app already uses; ids only need to be unique per account.
- `updatedAt` is the time of the local edit in milliseconds. The server keeps whichever copy has the newest `updatedAt` (last write wins).
- Deletions are sent as records with `deleted: true` and kept as tombstones so other devices learn about them.

The response returns every record for the account that changed after `cursor` (including the ones just sent), plus the new `cursor` to store:

```json
{ "cursor": 42, "courses": [{ "uid": "…", "clientId": "…", "…": "…" }], "rounds": [{ "shareToken": "…", "…": "…" }], "bag": null }
```

The client applies each returned record if its `updatedAt` is newer than the local copy. Courses gain a public `uid`, and shared rounds gain a `shareToken` for their public link.

## Privacy

- Courses are public only while `published` is true.
- Rounds are public only while `shared` is true, through an unguessable share token. A shared round also exposes the tee and basket positions of the course it was played on, so the website can draw its map.
- Bags are always private.
