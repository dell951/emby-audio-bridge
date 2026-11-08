export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  cacheAheadSeconds: 30,
  cacheBehindSeconds: 180,
  cacheMaxMiB: 96
});

export function normalizeAudioSettings(settings = {}) {
  const number = (key, min, max, step, fallback) => {
    const value = Number(settings[key]);
    if (!Number.isFinite(value)) return fallback;
    const stepped = Math.round(value / step) * step;
    return Math.min(max, Math.max(min, stepped));
  };
  return {
    cacheAheadSeconds: number('cacheAheadSeconds', 10, 120, 5, DEFAULT_AUDIO_SETTINGS.cacheAheadSeconds),
    cacheBehindSeconds: number('cacheBehindSeconds', 0, 600, 30, DEFAULT_AUDIO_SETTINGS.cacheBehindSeconds),
    cacheMaxMiB: number('cacheMaxMiB', 32, 512, 32, DEFAULT_AUDIO_SETTINGS.cacheMaxMiB)
  };
}
