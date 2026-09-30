import { createApp } from './app.ts';
import { createPostgresDb, migrate } from './db.ts';

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const db = createPostgresDb(requireEnv('DATABASE_URL'));
await migrate(db);

const app = createApp({
  db,
  authSecret: requireEnv('AUTH_SECRET'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  tileUrl: process.env.TILE_URL || undefined,
  tileAttribution: process.env.TILE_ATTRIBUTION || undefined,
});
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Glide Path API listening on port ${port}`);
});
