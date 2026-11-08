export class AudioCache {
  constructor({behind=180,ahead=30,maxBytes=96*1024*1024}={}) {
    Object.assign(this,{behind,ahead,maxBytes}); this.chunks=[];
  }
  configure({behind=this.behind,ahead=this.ahead,maxBytes=this.maxBytes}={}) {
    Object.assign(this,{behind,ahead,maxBytes});
    if (Number.isFinite(this.lastTime)) this.prune(this.lastTime);
  }
  clear() { this.chunks=[]; }
  add(chunk,time) { this.chunks.push(chunk); this.prune(time); }
  contains(time) { return this.chunks.some(c=>time>=c.start && time<c.start+c.buffer.duration); }
  frontier(time) {
    let end=time;
    for(const c of [...this.chunks].sort((a,b)=>a.start-b.start)) {
      if(c.start<=end+.001 && c.start+c.buffer.duration>end) end=c.start+c.buffer.duration;
    }
    return end;
  }
  prune(time) {
    this.lastTime=time;
    this.chunks=this.chunks.filter(c=>c.start+c.buffer.duration>time-this.behind && c.start<time+this.ahead+24);
    const bytes=c=>c.buffer.length*c.buffer.numberOfChannels*4;
    let total=this.chunks.reduce((n,c)=>n+bytes(c),0);
    // Evict the most distant audio first, keeping audio near the playhead.
    while(total>this.maxBytes && this.chunks.length>1) {
      let victim=0;
      for(let i=1;i<this.chunks.length;i++) if(Math.abs(this.chunks[i].start-time)>Math.abs(this.chunks[victim].start-time)) victim=i;
      total-=bytes(this.chunks[victim]); this.chunks.splice(victim,1);
    }
  }
}
