// Global settings, edited on the Settings screen and stored in app_settings.
import { db, getSetting, setSetting } from './db.ts';
import { HttpError } from './sorts.ts';
import { DEFAULT_SCORE_CODE } from './shared/analysis.js';

export interface AppSettings {
  /** Used for channels that haven't been set up yet. */
  channelDefaults: { targetHours: number; alignStart: boolean };
  /** Repeat colours on timelines, in minutes from the last airing's time of day. */
  thresholds: { tight: number; loose: number };
  /** Compare and "keep the best": candidates per sort. */
  candidates: number;
  backupsPerChannel: number;
  sortTimeLimitSec: number;
  scoreCode: string;
  watchTracker: {
    enabled: boolean;
    /** Minutes an episode must stream before it counts as watched. */
    minMinutes: number;
    /** Watches kept per episode per channel (newest first). */
    keepPerEpisode: number;
    /** Forget watches older than this many days; 0 = keep until pushed out by newer ones. */
    maxAgeDays: number;
  };
  automations: {
    /** Off = timetables don't run (Run now and dry runs still work). */
    enabled: boolean;
    /** Timetables without a set time run somewhere in this window (HH:MM, local time). */
    windowStart: string;
    windowEnd: string;
    /** Automations running at once. */
    concurrency: number;
    /** Sandbox time per run, not counting builds, applies and AI calls. */
    timeLimitSec: number;
    /** Retries when Tunarr can't be reached. */
    retries: number;
    retryDelayMin: number;
    keepRunsDays: number;
  };
}

export const SETTING_DEFAULTS: AppSettings = {
  channelDefaults: { targetHours: 168, alignStart: true },
  thresholds: { tight: 30, loose: 720 },
  candidates: 6,
  backupsPerChannel: 20,
  sortTimeLimitSec: 10,
  scoreCode: DEFAULT_SCORE_CODE,
  watchTracker: { enabled: true, minMinutes: 5, keepPerEpisode: 5, maxAgeDays: 0 },
  automations: { enabled: true, windowStart: '01:00', windowEnd: '05:00', concurrency: 1, timeLimitSec: 60, retries: 2, retryDelayMin: 15, keepRunsDays: 90 },
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
  watchTracker: v => ({
    enabled: v?.enabled !== false,
    minMinutes: num(v?.minMinutes, 1, 120, 'Minutes before it counts'),
    keepPerEpisode: Math.round(num(v?.keepPerEpisode, 1, 100, 'Watches kept per episode')),
    maxAgeDays: Math.round(num(v?.maxAgeDays ?? 0, 0, 3650, 'Forget watches older than (days)')),
  }),
  automations: v => {
    const hhmm = (x: unknown, what: string) => {
      const m = /^(d{1,2}):(d{2})$/.exec(String(x ?? '').trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new HttpError(400, `${what} must be a time like 01:00.`);
      return `${m[1].padStart(2, '0')}:${m[2]}`;
    };
    return {
      enabled: v?.enabled !== false,
      windowStart: hhmm(v?.windowStart, 'The window start'),
      windowEnd: hhmm(v?.windowEnd, 'The window end'),
      concurrency: Math.round(num(v?.concurrency, 1, 2, 'Automations at once')),
      timeLimitSec: num(v?.timeLimitSec, 5, 600, 'The automation time limit (seconds)'),
      retries: Math.round(num(v?.retries, 0, 10, 'Retries')),
      retryDelayMin: num(v?.retryDelayMin, 1, 240, 'Minutes between retries'),
      keepRunsDays: Math.round(num(v?.keepRunsDays, 1, 3650, 'Days of run history')),
    };
  },
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
