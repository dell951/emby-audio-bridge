// Video time is authoritative. All chunks share one audio-clock anchor.
export class AudioTimeline {
  constructor(context, destination) {
    this.context = context;
    this.destination = destination;
    this.nodes = new Map();
  }
  stop() {
    for (const node of this.nodes.values()) {
      node.onended = null;
      try { node.stop(); } catch {}
      node.disconnect();
    }
    this.nodes.clear();
    this.anchor = undefined;
  }
  sync(time, rate, chunks) {
    const clock = this.context.currentTime;
    if (this.anchor && (this.anchor.rate !== rate ||
        Math.abs(this.anchor.time + (clock-this.anchor.clock)*rate-time) > .15)) this.stop();
    if (!this.anchor) this.anchor = {time, clock, rate};
    for (const chunk of chunks) {
      const end = chunk.start + chunk.buffer.duration;
      if (end <= time || this.nodes.has(chunk)) continue;
      const begin = Math.max(time, chunk.start);
      const when = this.anchor.clock + (begin-this.anchor.time)/rate;
      const node = this.context.createBufferSource();
      node.buffer = chunk.buffer;
      node.playbackRate.value = rate;
      node.connect(this.destination);
      node.onended = () => { this.nodes.delete(chunk); node.disconnect(); };
      this.nodes.set(chunk, node);
      node.start(Math.max(clock, when), begin-chunk.start);
    }
  }
  get active() { return this.nodes.size > 0; }
}
