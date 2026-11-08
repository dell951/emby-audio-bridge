// PCM is streamed while FFmpeg runs: longer jobs reduce repeated MKV seeks
// without requiring the entire job to complete before audio can play.
export const DECODE_SECONDS = 24;
export function resumeSeconds(rate, remaining = Infinity) {
  return Math.min(6 * rate, Math.max(0, remaining));
}
export function mustWait({available, buffering, rate, remaining}) {
  // Enter buffering before exhausting the audio, then rebuild a larger margin.
  const threshold = buffering ? resumeSeconds(rate, remaining) : Math.min(.25 * rate, remaining);
  return available < threshold;
}
