// Checks that the database lives somewhere that survives container updates.
// In Docker that means /data is a mounted volume (or a bind-mounted folder);
// otherwise every update starts with an empty database.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export interface StorageStatus {
  dbFile: string;
  /** true = on a mount, false = inside the container only, null = can't tell (not Linux / not Docker). */
  persistent: boolean | null;
  /** Docker volume name when it can be read from the mount table. */
  volume: string | null;
  warning: string | null;
}

let cached: StorageStatus | null = null;

export function storageStatus(): StorageStatus {
  if (cached) return cached;
  const dbFile = path.join(config.dataDir, 'schedule-lab.db');
  const status: StorageStatus = { dbFile, persistent: null, volume: null, warning: null };
  const inDocker = fs.existsSync('/.dockerenv');
  let mountinfo = '';
  try { mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch { /* not Linux */ }
  if (inDocker && mountinfo) {
    const dir = path.resolve(config.dataDir);
    // Fields: id parent major:minor root mount-point ...
    const mount = mountinfo.split('\n').map(l => l.split(' ')).find(f => f[4] === dir);
    if (!mount) {
      status.persistent = false;
      status.warning = `${dir} isn't a Docker volume, so your sorts and channel setup are lost whenever the container is recreated (for example on update). Mount a volume at ${dir}, as docker-compose.yml does.`;
    } else {
      status.persistent = true;
      const m = /\/volumes\/([^/]+)\/_data/.exec(mount[3]);
      status.volume = m ? m[1] : null;
      if (status.volume && /^[0-9a-f]{64}$/.test(status.volume)) {
        status.warning = `${dir} is on an unnamed Docker volume, which a fresh container may not reuse. Use a named volume (docker-compose.yml uses schedule-lab-data) so updates keep your data.`;
      }
    }
  }
  cached = status;
  return status;
}
