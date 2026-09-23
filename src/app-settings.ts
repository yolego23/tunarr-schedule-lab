// Global settings, edited on the Settings screen and stored in app_settings.
import { db, getSetting, setSetting } from './db.ts';
import { HttpError } from './sorts.ts';
import { DEFAULT_SCORE_CODE } from './shared/analysis.js';

export interface AppSettings {
  /** Used for channels that haven't been set up yet. */
  channelDefaults: { targetHours: number; alignStart: boolean };
  /** Repeat colours on timelines, in minutes from the last airing's time of day. */
  thresholds: { tight: number; loose: number };
  /** Preview & Compare: candidates per sort. */
  candidates: number;
  backupsPerChannel: number;
  sortTimeLimitSec: number;
  scoreCode: string;
}

export const SETTING_DEFAULTS: AppSettings = {
  channelDefaults: { targetHours: 168, alignStart: true },
  thresholds: { tight: 30, loose: 720 },
  candidates: 6,
  backupsPerChannel: 20,
  sortTimeLimitSec: 10,
  scoreCode: DEFAULT_SCORE_CODE,
};

type Key = keyof AppSettings;

function num(v: unknown, min: number, max: number, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${what} must be between ${min} and ${max}.`);
  return n;
}

const VALIDATE: { [K in Key]: (v: any) => AppSettings[K] } = {
  channelDefaults: v => ({
    targetHours: num(v?.targetHours, 1, 24 * 400, 'Lineup length (hours)'),
    alignStart: v?.alignStart !== false,
  }),
  thresholds: v => {
    const tight = num(v?.tight, 0, 1440, 'The red threshold');
    const loose = num(v?.loose, 0, 1440, 'The green threshold');
    if (loose < tight) throw new HttpError(400, 'The green threshold must be at least the red one.');
    return { tight, loose };
  },
  candidates: v => Math.round(num(v, 1, 30, 'Candidates per sort')),
  backupsPerChannel: v => Math.round(num(v, 1, 100, 'Backups per channel')),
  sortTimeLimitSec: v => num(v, 1, 60, 'The sort time limit (seconds)'),
  scoreCode: v => {
    if (typeof v !== 'string' || !/function\s+score\s*\(/.test(v)) throw new HttpError(400, 'The scoring code must define function score(ctx).');
    return v;
  },
};

export function isSettingKey(key: string): key is Key {
  return key in SETTING_DEFAULTS;
}

export function appSetting<K extends Key>(key: K): AppSettings[K] {
  const v = getSetting<AppSettings[K]>(key, SETTING_DEFAULTS[key]);
  // Objects saved by older versions may miss newer fields.
  if (v && typeof v === 'object' && !Array.isArray(v)) return { ...(SETTING_DEFAULTS[key] as object), ...(v as object) } as AppSettings[K];
  return v;
}

export function allSettings(): AppSettings {
  return Object.fromEntries((Object.keys(SETTING_DEFAULTS) as Key[]).map(k => [k, appSetting(k)])) as unknown as AppSettings;
}

export function saveAppSetting(key: string, value: unknown) {
  if (!isSettingKey(key)) throw new HttpError(404, `Unknown setting "${key}".`);
  const clean = VALIDATE[key](value);
  setSetting(key, clean);
  return clean;
}

export function resetAppSetting(key: string) {
  if (!isSettingKey(key)) throw new HttpError(404, `Unknown setting "${key}".`);
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  return SETTING_DEFAULTS[key];
}
