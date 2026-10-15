// Ground elevation (metres) from the public Terrarium terrain tiles the website's 3D view uses,
// for the app and website's flat-ground throw distances. Phone GPS heights are too rough for this.
// Pixels are decoded here (a small PNG reader, since the tiles are plain 8-bit RGB), and recent
// tiles are kept in memory: one course needs only a few.
import { inflateSync } from 'node:zlib';

export const TERRAIN_TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
// About 5 m per pixel; must match TERRAIN_ZOOM in public/js/course-holes.js.
const TERRAIN_ZOOM = 15;
const CACHED_TILES = 100;

export type GroundPoint = { latitude: number; longitude: number };
export type ElevationLookup = (points: GroundPoint[]) => Promise<(number | null)[]>;
type Pixels = { width: number; channels: number; data: Uint8Array };

// Decodes a non-interlaced 8-bit RGB or RGBA PNG into its pixels.
export const decodePng = (png: Uint8Array): Pixels => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [bitDepth, colorType, , , interlace] = body.subarray(8, 13);
      if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('Unsupported terrain tile format.');
      channels = colorType === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = row * stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? data[out + index - channels] : 0;
      const up = row ? data[out - stride + index] : 0;
      const upLeft = row && index >= channels ? data[out - stride + index - channels] : 0;
      let value = line[index];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      }
      data[out + index] = value & 0xff;
    }
  }
  return { width, channels, data };
};

const fetchTile = async (x: number, y: number) => {
  const url = TERRAIN_TILE_URL.replace('{z}', String(TERRAIN_ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Terrain tile ${x}/${y}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

// Looks up points' ground elevations, null where a tile can't be had. `loadTile` fetches a
// zoom-15 tile's PNG (the public tiles by default).
export const createElevationLookup = (loadTile: (x: number, y: number) => Promise<Uint8Array> = fetchTile): ElevationLookup => {
  const tiles = new Map<string, Promise<Pixels | null>>();
  const tile = (x: number, y: number) => {
    const key = `${x}/${y}`;
    let pixels = tiles.get(key);
    if (pixels) {
      tiles.delete(key); // most recently used last
    } else {
      pixels = loadTile(x, y).then(decodePng, () => null);
      // A failed tile is tried again next time.
      pixels.then((result) => { if (!result) tiles.delete(key); });
    }
    tiles.set(key, pixels);
    if (tiles.size > CACHED_TILES) tiles.delete(tiles.keys().next().value!);
    return pixels;
  };
  return (points) => Promise.all(points.map(async ({ latitude, longitude }) => {
    const scale = 2 ** TERRAIN_ZOOM;
    const x = ((longitude + 180) / 360) * scale;
    const latitudeRad = (latitude * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latitudeRad) + 1 / Math.cos(latitudeRad)) / Math.PI) / 2) * scale;
    const pixels = await tile(Math.floor(x), Math.floor(y));
    if (!pixels) return null;
    const offset = (Math.floor((y % 1) * 256) * pixels.width + Math.floor((x % 1) * 256)) * pixels.channels;
    const [red, green, blue] = pixels.data.subarray(offset, offset + 3);
    return Math.round((red * 256 + green + blue / 256 - 32768) * 100) / 100;
  }));
};
