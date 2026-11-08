import { needsAudioBridge } from './codecs.js';
import { position, covers } from './clock.js';
import { DECODE_SECONDS, mustWait, resumeSeconds } from './buffer-policy.js';
import { AudioCache } from './cache.js';
import { AudioTimeline } from './timeline.js';
const SITE = 'https://st.stentvessel.xyz';
let state, worker, context, gain, timeline, busy = false, epoch = 0;
const cache = new AudioCache();
let input, size, codec, sourceURL, lastMessage = 0;
let nextId = 0;
let pcmSink;
let io, lastError;
let networkMs=0, lastJobNetworkMs=0, lastJobOtherMs=0;
let phase = 'idle', fetched = 0, lastDecodeMs = 0;
const calls = new Map();
function rpc(type, data) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    calls.set(id, {resolve, reject});
    worker.postMessage({id, type, data});
  });
}
function silence() { timeline?.stop(); }
function cancel(full = true) {
  ++epoch;
  silence();
  // An idle decoder can retain the compiled WASM and Range cache on seek.
  // A busy worker must be terminated because FFmpeg blocks its event loop.
  if (full || busy) {
    worker?.terminate(); worker = undefined; input = undefined;
    for (const call of calls.values()) call.reject(new Error('cancelled'));
    calls.clear();
  }
  if (full) cache.clear(); busy = false; pcmSink = undefined;
}
async function initialize() {
  worker = new Worker('decode-worker.js', {type:'module'});
  worker.onmessage = ({data:m}) => {
    if (m.type === 'io') { io=m.data; if (Number.isFinite(io.elapsedMs)) networkMs+=io.elapsedMs; return; }
    if (m.type === 'netstat') { fetched = m.data.fetched; return; }
    if (m.type === 'chunk') { pcmSink?.(m.data); return; }
    if (m.type === 'log') {
      const match = /Audio: (\w+)/.exec(m.data);
      if (match && codec === undefined) codec = match[1];
      return; // Never log media URLs or FFmpeg output containing credentials.
    }
    const call = calls.get(m.id);
    if (call) {
      calls.delete(m.id);
      m.type === 'error' ? call.reject(new Error(m.data.message)) : call.resolve(m.data);
    }
  };
  worker.onerror = () => { cancel(); console.warn('Audio Bridge: decoder failed'); };
  phase='loading-wasm';
  await rpc('init', {coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'), wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
  phase='mounting-source';
  input = (await rpc('setSource', {url:sourceURL, size, name:'input.mkv', chunkSize:1024*1024})).path;
  phase='probing-audio';
  if (codec === undefined) await rpc('exec', {args:['-hide_banner','-analyzeduration','100000','-probesize','262144','-i',input]});
}
async function decode(start, duration = DECODE_SECONDS) {
  if (busy || codec === 'unsupported') return;
  busy = true; phase = 'initializing';
  const began = performance.now();
  const generation = epoch;
  const networkAtStart=networkMs;
  try {
    if (!size) {
      const response = await fetch(sourceURL, {headers:{Range:'bytes=0-1'},signal:AbortSignal.timeout(15000)});
      const range = response.headers.get('content-range');
      response.body?.cancel().catch(()=>{});
      if (generation !== epoch) return;
      if (response.status !== 206 || !/\/\d+$/.test(range || '')) throw new Error('Range required');
      size = Number(range.split('/')[1]);
    }
    if (!worker) await initialize();
    if (generation !== epoch) return;
    if (!needsAudioBridge(codec)) { codec = 'unsupported'; cancel(); return; }
    // Initialization may take seconds: begin at the current video position.
    if (!cache.chunks.length && state && !state.paused) start = position(state, performance.timeOrigin + performance.now());
    phase = 'decoding';
    let emitted = 0;
    pcmSink = data => {
      if (generation !== epoch) return;
      const floats = new Float32Array(data);
      const frames = Math.floor(floats.length/2);
      if (!frames) return;
      const buffer = context.createBuffer(2, frames, 48000);
      for (let channel=0;channel<2;channel++) {
        const out = buffer.getChannelData(channel);
        for (let i=0;i<frames;i++) out[i] = floats[i*2+channel];
      }
      cache.add({start:start+emitted/48000, buffer}, state.time);
      emitted += frames;
    };
    const result = await rpc('stream', {args:['-hide_banner','-loglevel','error','-ss',String(start),'-analyzeduration','100000','-probesize','262144','-i',input,'-t',String(duration),'-map','0:a:0','-vn','-sn','-ac','2','-ar','48000','-c:a','pcm_f32le','-f','f32le','-y','/audio.pcm'],outPath:'/audio.pcm',pcm:true});
    if (result.ret !== 0) throw new Error('decode failed');
    if (generation === epoch) pcmSink = undefined;
  } catch (error) {
    if (generation === epoch) { lastError=error.message; cancel(); phase='error'; console.warn('Audio Bridge: audio unavailable; native video retained'); }
  } finally { if (generation === epoch) { busy = false; phase = 'idle'; lastDecodeMs = performance.now()-began; lastJobNetworkMs=networkMs-networkAtStart; lastJobOtherMs=Math.max(0,lastDecodeMs-lastJobNetworkMs); } }
}
function tick() {
  if (!state || Date.now() - lastMessage > 500) { silence(); return; }
  if (state.paused || state.seeking) { silence(); return; }
  if (codec === 'unsupported') return;
  const time = position(state, performance.timeOrigin + performance.now());
  cache.prune(time);
  const chunks = cache.chunks;
  const chunk = chunks.find(c => covers(c,time));
  const available=cache.frontier(time)-time;
  const remaining=Number.isFinite(state.duration) ? Math.max(0,state.duration-time) : Infinity;
  const required=resumeSeconds(state.rate,remaining);
  const needsWait=!chunk || mustWait({available,buffering:state.buffering,rate:state.rate,remaining});
  if (needsAudioBridge(codec) && needsWait!==Boolean(state.buffering)) {
    parent.postMessage({type:'audio-bridge-buffer',wait:needsWait,time:state.time},SITE);
  }
  if (state.buffering || needsWait) {
    silence();
    if (available<required) decode(chunk ? cache.frontier(time) : time,DECODE_SECONDS);
    return;
  }
  if (context.state === 'running') timeline.sync(time, state.rate, chunks.filter(c => c.start+c.buffer.duration>time && c.start<time+30));
  gain.gain.value=state.volume;
  if (!chunk) decode(time, DECODE_SECONDS);
  else {
    const frontier = cache.frontier(time);
    if (frontier-time < 30) decode(frontier, DECODE_SECONDS);
  }
}
window.addEventListener('message', ({origin,source,data}) => {
  if (origin !== SITE || source !== parent || data?.type !== 'audio-bridge-state') return;
  try { if (new URL(data.url).origin !== SITE) return; } catch { return; }
  if (!Number.isFinite(data.time) || !Number.isFinite(data.rate) || data.rate <= 0) return;
  if (!context) { context=new AudioContext(); gain=context.createGain(); gain.connect(context.destination); timeline=new AudioTimeline(context,gain); }
  if (sourceURL !== data.url) { cancel(); sourceURL=data.url; codec=undefined; size=undefined; }
  if ((data.seeking && !state?.seeking) || (state && Math.abs(data.time-position(state,data.stamp)) > .5)) cancel(false);
  state=data; lastMessage=Date.now();
  if (data.paused || data.seeking) silence();
  else context.resume().catch(() => {});
  tick();
});
window.addEventListener('pagehide', () => { cancel(); context?.close(); });
setInterval(tick,50);

// Read-only diagnostics for local acceptance testing; excludes media URLs.
export function diagnostics() {
  return {codec, phase, io, lastError, fetched, lastDecodeMs, lastJobNetworkMs, lastJobOtherMs, context:context?.state, decoding:busy, generation:epoch,
    videoTime:state?.time, audible:Boolean(timeline?.active), audioAnchor:timeline?.anchor?.time,
    buffered:cache.chunks.map(c=>({start:c.start,duration:c.buffer.duration}))};
}
