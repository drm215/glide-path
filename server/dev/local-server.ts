import { networkInterfaces } from 'node:os';
import { createApp } from '../src/app.ts';
import { createPgliteDb } from './pglite-db.ts';

// Runs the API with an embedded database stored in server/.local-data, so the app can be
// tested from a phone on the same Wi-Fi without Neon or Render.
const db = await createPgliteDb('./.local-data');
const app = createApp({ db, authSecret: 'local-development-secret-not-for-production', rateLimitAuth: false });
const port = Number(process.env.PORT) || 3000;

app.listen(port, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => `http://${net!.address}:${port}`);
  console.log(`Local Glide Path API on port ${port}`);
  console.log('Start the app with one of these, from the project root:');
  for (const address of addresses) console.log(`  $env:EXPO_PUBLIC_API_URL="${address}"; npx expo start`);
});
