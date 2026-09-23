import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  /** The only required setting. */
  tunarrUrl: (process.env.TUNARR_URL || '').replace(/\/+$/, ''),
  port: Number(process.env.PORT) || 8765,
  dataDir: process.env.DATA_DIR || path.resolve(here, '..', 'data'),
  publicDir: path.resolve(here, '..', 'public'),
  sharedDir: path.resolve(here, 'shared'),
  /** Tunarr versions this build was tested against. */
  testedTunarrVersions: ['1.3.15'],
  /** Default custom sort time limit, in ms of sandbox time (the Settings screen overrides it). */
  sortTimeLimitMs: 10_000,
  /** Sandboxes that may run at once. */
  sandboxConcurrency: 2,
};
