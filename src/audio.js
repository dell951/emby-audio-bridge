import { needsAudioBridge } from './codecs.js';
import { position, covers } from './clock.js';
import { DECODE_SECONDS, mustWait, resumeSeconds } from './buffer-policy.js';
import { AudioCache } from './cache.js';
import { AudioTimeline } from './timeline.js';
import { DEFAULT_AUDIO_SETTINGS, normalizeAudioSettings } from './settings.js';
let siteOrigin;
const expectedParentOrigin = new URLSearchParams(location.search).get('parentOrigin');
let state, worker, context, gain, timeline, busy = false, epoch = 0;
const cache = new AudioCache();
function applyAudioSettings(raw) {
  const settings = normalizeAudioSettings(raw);
  cache.configure({behind:settings.cacheBehindSeconds,ahead:settings.cacheAheadSeconds,maxBytes:settings.cacheMaxMiB*1024*1024});
}
chrome.storage.local.get('audioSettings').then(({audioSettings}) => applyAudioSettings({...DEFAULT_AUDIO_SETTINGS,...audioSettings}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.audioSettings) applyAudioSettings(changes.audioSettings.newValue);
});
let input, size, codec, sourceURL, lastMessage = 0;
let nextId = 0;
let pcmSink;
let io, lastError, decoderError;
let networkMs=0, lastJobNetworkMs=0, lastJobOtherMs=0;
let phase = 'idle', fetched = 0, lastDecodeMs = 0, lastWorkerLog = '', decodeStart = 0, decodeDuration = DECODE_SECONDS, pcmSeconds = 0;
let lastStatusPost = 0;
const calls = new Map();
function safeErrorMessage(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL 已隐藏]')
    .replace(/(api_key|token|X-Emby-Token)=([^&\s]+)/gi, '$1=[已隐藏]')
    .slice(0, 180);
}
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
      lastWorkerLog=safeErrorMessage(m.data);
      if (/error|invalid|unsupported|failed|corrupt/i.test(m.data)) decoderError=lastWorkerLog;
      return; // Never log media URLs or FFmpeg output containing credentials.
    }
    const call = calls.get(m.id);
    if (call) {
      calls.delete(m.id);
      m.type === 'error' ? call.reject(new Error(m.data.message)) : call.resolve(m.data);
    }
  };
  worker.onerror = event => {
    lastError=safeErrorMessage(event.message || '解码 Worker 异常退出');
    cancel(); phase='error';
    console.warn('Audio Bridge: decoder failed:', lastError);
  };
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
  decoderError=undefined;
  const began = performance.now();
  const generation = epoch;
  const networkAtStart=networkMs;
  decodeStart=start; decodeDuration=duration; pcmSeconds=0;
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
    if (!needsAudioBridge(codec)) {
      codec = 'unsupported'; phase='native'; cancel();
      if (siteOrigin) parent.postMessage({type:'audio-bridge-buffer',wait:false,time:state.time},siteOrigin);
      return;
    }
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
      pcmSeconds=emitted/48000;
    };
    const result = await rpc('stream', {args:['-hide_banner','-loglevel','error','-ss',String(start),'-analyzeduration','100000','-probesize','262144','-i',input,'-t',String(duration),'-map','0:a:0','-vn','-sn','-ac','2','-ar','48000','-c:a','pcm_f32le','-f','f32le','-y','/audio.pcm'],outPath:'/audio.pcm',pcm:true});
    if (result.ret !== 0) throw new Error(decoderError || `FFmpeg exited with code ${result.ret}`);
    if (generation === epoch) { pcmSink = undefined; lastError=undefined; }
  } catch (error) {
    if (generation === epoch) {
      lastError=safeErrorMessage(error); cancel(); phase='error';
      console.warn('Audio Bridge: audio unavailable; native video retained:', lastError);
    }
  } finally {
    if (generation === epoch) {
      busy = false;
      if (phase !== 'error') phase = 'idle';
      lastDecodeMs = performance.now()-began;
      lastJobNetworkMs=networkMs-networkAtStart;
      lastJobOtherMs=Math.max(0,lastDecodeMs-lastJobNetworkMs);
    }
  }
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
  // Hold video while codec probing is unresolved, then keep A/V synchronized
  // until a bridge codec has enough decoded PCM to resume.
  if (codec !== 'unsupported' && needsWait!==Boolean(state.buffering)) {
    if (siteOrigin) parent.postMessage({type:'audio-bridge-buffer',wait:needsWait,time:state.time},siteOrigin);
  }
  if (state.buffering || needsWait) {
    silence();
    if (available<required) decode(chunk ? cache.frontier(time) : time,DECODE_SECONDS);
    return;
  }
  if (context.state === 'running') timeline.sync(time, state.rate, chunks.filter(c => c.start+c.buffer.duration>time && c.start<time+cache.ahead));
  gain.gain.value=state.volume;
  if (!chunk) decode(time, DECODE_SECONDS);
  else {
    const frontier = cache.frontier(time);
    if (frontier-time < cache.ahead) decode(frontier, DECODE_SECONDS);
  }
}
window.addEventListener('message', ({origin,source,data}) => {
  if (source !== parent || data?.type !== 'audio-bridge-state') return;
  try {
    if (origin !== expectedParentOrigin || new URL(data.url).origin !== origin || (siteOrigin && siteOrigin !== origin)) return;
    siteOrigin = origin;
  } catch { return; }
  if (!Number.isFinite(data.time) || !Number.isFinite(data.rate) || data.rate <= 0) return;
  if (!context) { context=new AudioContext(); gain=context.createGain(); gain.connect(context.destination); timeline=new AudioTimeline(context,gain); }
  if (sourceURL !== data.url) { cancel(); sourceURL=data.url; codec=undefined; size=undefined; lastError=undefined; decoderError=undefined; phase='idle'; fetched=0; }
  if ((data.seeking && !state?.seeking) || (state && Math.abs(data.time-position(state,data.stamp)) > .5)) cancel(false);
  state=data; lastMessage=Date.now();
  if (data.paused || data.seeking) silence();
  else context.resume().catch(() => {});
  tick();
});
window.addEventListener('pagehide', () => { cancel(); context?.close(); });
setInterval(tick,50);

function publishStatus() {
  if (!state || !siteOrigin || Date.now()-lastStatusPost<450) return;
  lastStatusPost=Date.now();
  const time=position(state,performance.timeOrigin+performance.now());
  const starts=cache.chunks.map(chunk=>chunk.start);
  const currentIO=io ? {state:String(io.state||''),start:Number(io.start)||0,length:Number(io.length)||0,elapsedMs:io.state==='request'&&io.requestAt?Date.now()-io.requestAt:(Number(io.elapsedMs)||0),status:Number(io.status)||0,bytes:Number(io.bytes)||0} : null;
  parent.postMessage({type:'audio-bridge-status',status:{
    codec:codec==='unsupported'?'native':(codec || 'probing'), phase,
    context:context?.state || 'uninitialized', decoding:busy,
    audible:Boolean(context?.state==='running' && timeline?.active),
    paused:Boolean(state.paused), buffering:Boolean(state.buffering),
    bufferedAhead:Math.max(0,cache.frontier(time)-time),
    bufferedBehind:starts.length?Math.max(0,time-Math.min(...starts)):0,
    fetched, lastDecodeMs, lastJobNetworkMs, lastJobOtherMs, error:lastError || '',
    mediaTime:time, decodeStart, decodeDuration, pcmSeconds, cacheChunks:cache.chunks.length,
    networkMs, io:currentIO, workerLog:lastWorkerLog
  }},siteOrigin);
}
setInterval(publishStatus,500);
if (expectedParentOrigin && /^https?:\/\//.test(expectedParentOrigin)) parent.postMessage({type:'audio-bridge-ready'},expectedParentOrigin);

// Read-only diagnostics for local acceptance testing; excludes media URLs.
export function diagnostics() {
  return {codec, phase, io, lastError, fetched, lastDecodeMs, lastJobNetworkMs, lastJobOtherMs, context:context?.state, decoding:busy, generation:epoch,
    videoTime:state?.time, audible:Boolean(timeline?.active), audioAnchor:timeline?.anchor?.time,
    buffered:cache.chunks.map(c=>({start:c.start,duration:c.buffer.duration}))};
}
