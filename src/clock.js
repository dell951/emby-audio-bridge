export function position(state, now) {
  return state.time + ((state.paused || state.buffering) ? 0 : Math.max(0, now - state.stamp) / 1000 * state.rate);
}
export function covers(chunk, time) {
  return chunk && time >= chunk.start && time < chunk.start + chunk.buffer.duration;
}
