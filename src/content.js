(() => {
  // Capture extension metadata while the content script context is live.
  // Existing tabs can keep an old content script briefly after an extension
  // reload; calling runtime APIs from a timer then throws "context invalidated".
  let extensionBaseUrl = '';
  let extensionVersion = 'unknown';
  try {
    extensionBaseUrl = chrome.runtime.getURL('/');
    extensionVersion = chrome.runtime.getManifest().version || extensionVersion;
  } catch {}
  const extensionOrigin = extensionBaseUrl ? new URL(extensionBaseUrl).origin : '';
  let session;
  let extensionInvalidated=false;
  let scanTimer;
  const source = v => v.currentSrc || v.src || v.querySelector('source')?.src;
  const codecName = codec => ({ac3:'AC-3',eac3:'E-AC-3',dts:'DTS',native:'浏览器原生音轨',probing:'探测中'})[codec] || String(codec || '未知');
  const phaseName = phase => ({idle:'待命',initializing:'初始化', 'loading-wasm':'加载解码器','mounting-source':'打开媒体','probing-audio':'探测音轨',decoding:'解码中',error:'出错',native:'原生播放'})[phase] || phase || '等待状态';
  const contextName = context => ({running:'运行中',suspended:'暂停',closed:'已关闭',uninitialized:'未启动'})[context] || context || '未知';
  function diagnose(d) {
    const error=String(d.error||d.workerLog||'').toLowerCase();
    if (d.io?.state==='timeout') return ['网络 / 服务器访问','Range 请求超过 20 秒没有响应。解码已中止，视频应保持暂停；检查 Emby 服务器、网络或媒体地址后可尝试重新定位。'];
    if (d.io?.state==='request' && Number(d.io.elapsedMs)>15) return ['网络 / 服务器访问','Range 请求超过 15 秒仍未返回，当前卡在读取媒体数据。可能是网络、Emby 响应或临时媒体地址问题。'];
    if (/range required|http \d|network|fetch|xhr|timeout|range fetch/i.test(error)) return ['网络 / 服务器访问',d.error||d.workerLog];
    if (/wasm|worker|memory|allocation|securityerror|audiocontext/i.test(error) || d.phase==='loading-wasm' || d.context==='closed') return ['本地解码环境',d.error||d.workerLog||'解码器或浏览器音频环境未能启动。'];
    if (/unsupported|invalid data|moov atom|corrupt|decode failed|no audio|stream map/i.test(error) || d.codec==='unsupported') return ['媒体 / 音轨',d.error||d.workerLog||'当前媒体的音轨格式或数据未能通过探测/解码。'];
    if (d.codec==='native') return ['无需音频桥','该音轨由浏览器原生播放，不需要转码。'];
    if (d.buffering) return ['播放同步 / 缓存','音频尚未达到继续播放的缓存门槛；视频保持暂停，缓存就绪后会自动恢复。'];
    if (d.phase==='probing-audio' || d.phase==='mounting-source') return ['媒体探测 / 读取',d.io?.state==='request'?'FFmpeg 正在读取媒体 Range 数据；若等待时间持续增长，优先检查网络/服务器访问。':'正在打开媒体并探测音轨，尚未产出 PCM。'];
    if (d.codec && d.codec!=='probing' && !d.paused && !d.audible && Number(d.bufferedAhead)===0) return ['播放 / 音频输出','已识别音轨，但没有可播放的前方 PCM 缓存；检查解码进度与音频输出状态。'];
    if (d.error) return ['解码器 / 其他',d.error];
    return ['暂未发现异常',d.paused?'播放器已暂停。':d.audible?'音频桥正在输出音频。':'等待解码或缓存状态更新。'];
  }
  function audioHealth(d) {
    if (d.error) return {level:1,label:'解码异常'};
    if (!d.codec || d.codec==='probing' || ['initializing','loading-wasm','mounting-source','probing-audio'].includes(d.phase)) return {level:1,label:'探测中'};
    if (d.codec==='native') return {level:5,label:'原生音频'};
    if (d.buffering) return {level:2,label:'等待缓存'};
    const ahead=Number(d.bufferedAhead)||0;
    if (ahead>=20) return {level:5,label:'缓存充足'};
    if (ahead>=10) return {level:4,label:'状态良好'};
    if (ahead>=4) return {level:3,label:'缓存偏少'};
    if (ahead>0) return {level:2,label:'缓存不足'};
    return {level:1,label:d.audible?'缓存耗尽':'音频未就绪'};
  }
  function renderBadge(s) {
    if (extensionInvalidated || s.dead) return;
    try {
    const ui=s.badge;
    if (!ui) return;
    const d=s.status || {};
    // Keep the badge visible for the entire video session so probe stalls and
    // native-vs-bridge decisions remain visible to the user.
    ui.host.hidden=false;
    const label=d.error ? '解码异常' : d.codec==='probing' ? '音轨探测中' : d.codec==='native' ? '原生音频' : d.paused ? '已暂停' : d.buffering ? '等待音频' : d.audible ? '音频正常' : d.decoding ? '正在解码' : '音频启动中';
    ui.label.textContent=label;
    const health=audioHealth(d);
    ui.button.title=`音频状态 ${health.level}/5：${health.label} · 悬停查看解码详情`;
    ui.button.setAttribute('aria-label',`音频状态 ${health.level}/5，${health.label}`);
    ui.button.dataset.health=`${health.level}`;
    ui.button.classList.toggle('bad',Boolean(d.error));
    ui.button.classList.toggle('good',Boolean(d.audible && !d.error));
    ui.values.health.textContent=`${health.level}/5 · ${health.label}`;
    ui.values.codec.textContent=codecName(d.codec);
    ui.values.version.textContent=`v${extensionVersion}`;
    ui.values.phase.textContent=phaseName(d.phase);
    ui.values.context.textContent=contextName(d.context);
    ui.values.sync.textContent=d.held?'等待音频，视频已暂停':d.videoPaused?'视频已暂停':'音视频同步播放';
    ui.values.ahead.textContent=`${Number(d.bufferedAhead || 0).toFixed(1)} 秒`;
    ui.values.behind.textContent=`${Number(d.bufferedBehind || 0).toFixed(1)} 秒`;
    ui.values.decode.textContent=`${Number(d.lastDecodeMs || 0).toFixed(0)} 毫秒`;
    ui.values.fetched.textContent=`${(Number(d.fetched || 0)/1024/1024).toFixed(1)} MiB`;
    ui.values.errorRow.hidden=!d.error;
    ui.values.error.textContent=d.error || '';
    ui.values.time.textContent=`${Number(d.mediaTime || 0).toFixed(1)} 秒`;
    ui.values.range.textContent=`${Number(d.decodeStart || 0).toFixed(1)} 秒起，取 ${Number(d.decodeDuration || 0).toFixed(0)} 秒`;
    ui.values.pcm.textContent=`${Number(d.pcmSeconds || 0).toFixed(1)} 秒 / ${Number(d.cacheChunks || 0)} 段`;
    ui.values.io.textContent=d.io ? `${d.io.state==='request'?`等待中 ${Number(d.io.elapsedMs||0).toFixed(1)} 秒`:d.io.state==='timeout'?`超时 ${Number(d.io.elapsedMs||0).toFixed(0)} ms`:`已返回 ${Number(d.io.elapsedMs||0).toFixed(0)} ms`}${d.io.status ? ` · HTTP ${d.io.status}` : ''} · ${(Number(d.io.state==='request'?d.io.length:d.io.bytes || 0)/1024/1024).toFixed(1)} MiB` : '尚无请求';
    ui.values.work.textContent=`网络 ${Number(d.lastJobNetworkMs || 0).toFixed(0)} ms；其他 ${Number(d.lastJobOtherMs || 0).toFixed(0)} ms`;
    ui.values.log.textContent=d.workerLog || '尚无解码器日志';
    const [category,evidence]=diagnose(d);
    ui.values.category.textContent=category;
    ui.values.evidence.textContent=evidence;
    } catch (error) {
      if (!/extension context invalidated/i.test(String(error))) throw error;
      // Chrome can invalidate an old content-script world after an extension
      // reload. Stop its pollers instead of throwing the same error repeatedly.
      extensionInvalidated=true;
      s.dead=true;
      clearInterval(scanTimer);
      clearInterval(s.timer);
      for (const name of s.events) { try { s.video.removeEventListener(name,s.send); } catch {} }
      try { s.frame.remove(); } catch {}
      try { s.badge.host.remove(); } catch {}
      if (session===s) session=undefined;
    }
  }
  function createBadge() {
    const host=document.createElement('div');
    const shadow=host.attachShadow({mode:'closed'});
    shadow.innerHTML=`<style>
      :host{all:initial;display:block;box-sizing:border-box;position:fixed;z-index:2147483647;width:32px;height:32px;font:12px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#f4f4f4;pointer-events:none;opacity:.28;transition:opacity .18s ease}
      :host(:hover),:host([data-open="true"]){opacity:.82;visibility:visible}
      :host([data-idle="true"]):not([data-open="true"]){opacity:0;visibility:hidden}
      .wrap{position:absolute;inset:0 auto auto 0;width:32px;display:flex;flex-direction:column;align-items:center;pointer-events:none}
      .badge{position:relative;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:0;background:transparent;color:#f5f5f5;box-shadow:none;backdrop-filter:none;cursor:default;pointer-events:auto}
      .meter{display:flex;align-items:flex-end;gap:2px;height:18px}.meter i{display:block;width:3px;border-radius:2px;background:#ffffff30;transition:background .18s ease,opacity .18s ease}.meter i:nth-child(1){height:6px}.meter i:nth-child(2){height:9px}.meter i:nth-child(3){height:12px}.meter i:nth-child(4){height:15px}.meter i:nth-child(5){height:18px}.badge[data-health="1"] .meter i:nth-child(-n+1){background:#ff7068}.badge[data-health="2"] .meter i:nth-child(-n+2){background:#f18a55}.badge[data-health="3"] .meter i:nth-child(-n+3){background:#f2c75b}.badge[data-health="4"] .meter i:nth-child(-n+4){background:#9dcc72}.badge[data-health="5"] .meter i:nth-child(-n+5){background:#62cf8c}
      .label{display:none}
      .panel{display:none;width:min(340px,calc(100vw - 24px));max-height:min(70vh,560px);overflow:auto;margin-top:7px;padding:12px;border:1px solid #ffffff24;border-radius:10px;background:#202126ed;box-shadow:0 6px 24px #0007;backdrop-filter:blur(12px);pointer-events:auto}
      :host(:hover) .panel,:host([data-open="true"]) .panel{display:block}
      .title{margin:0 0 4px;font-size:13px;font-weight:700}.title [data-v="version"]{margin-left:4px;color:#aaa;font-size:10px;font-weight:500}.hint{margin:0 0 8px;color:#bbb;font-size:11px}.diagnosis{margin:0 0 8px;padding:8px;border-radius:7px;background:#3a3425}.evidence{color:#eee;font-size:11px;line-height:1.45;overflow-wrap:anywhere}.row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;color:#ddd;border-bottom:1px solid #ffffff12}.row b{color:#fff;font-weight:500;text-align:right;max-width:220px;overflow-wrap:anywhere}.section{margin:10px 0 4px;color:#b6c5d9;font-size:11px;font-weight:700;text-transform:uppercase}.log{margin:0;padding:7px;border-radius:6px;background:#111318;color:#d8d8d8;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.4 ui-monospace,monospace}.error{margin:8px 0 0;padding:7px;border-radius:6px;background:#712f35;color:#ffe2df;overflow-wrap:anywhere}
    </style><div class="wrap"><button class="badge" type="button" aria-expanded="false"><span class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="label">音频桥接</span></button><div class="panel"><p class="title">音频解码调试 <span data-v="version"></span></p><p class="hint">5 绿：前方缓存 ≥20 秒；4 绿：≥10 秒；3 黄：≥4 秒；2 橙：缓存偏低；1 红：探测或异常。状态每 0.5 秒刷新；点击徽标固定窗口。</p><div class="diagnosis"><div class="row"><span>初步归因</span><b data-v="category"></b></div><div class="evidence" data-v="evidence"></div></div><div class="row"><span>当前状态</span><b data-v="health"></b></div><div class="row"><span>音轨</span><b data-v="codec"></b></div><div class="row"><span>阶段</span><b data-v="phase"></b></div><div class="row"><span>音频输出</span><b data-v="context"></b></div><div class="row"><span>视频同步</span><b data-v="sync"></b></div><div class="row"><span>视频时间</span><b data-v="time"></b></div><div class="row"><span>本次解码</span><b data-v="range"></b></div><div class="row"><span>PCM 已产出 / 缓存段</span><b data-v="pcm"></b></div><div class="row"><span>前方已缓存</span><b data-v="ahead"></b></div><div class="row"><span>已播放缓存</span><b data-v="behind"></b></div><div class="row"><span>最近解码耗时</span><b data-v="decode"></b></div><div class="row"><span>媒体读取量</span><b data-v="fetched"></b></div><div class="row"><span>最近 Range 请求</span><b data-v="io"></b></div><div class="row"><span>最近任务耗时</span><b data-v="work"></b></div><p class="section">解码器最近日志</p><pre class="log" data-v="log"></pre><p class="error" data-v="error" hidden></p></div></div>`;
    const badge=shadow.querySelector('.badge');
    const values=Object.fromEntries([...shadow.querySelectorAll('[data-v]')].map(node=>[node.dataset.v,node]));
    const button=shadow.querySelector('.badge');
    button.addEventListener('click',()=>{host.dataset.open=host.dataset.open==='true'?'false':'true';button.setAttribute('aria-expanded',host.dataset.open);});
    return {host,button,label:shadow.querySelector('.label'),values:{...values,errorRow:shadow.querySelector('.error')}};
  }
  function positionBadge(s=session) {
    if (!s?.badge?.host) return;
    // Only anchor to the right side of the OSD header. `.headerSection` also
    // matches the left section (back/title controls), which can pin the badge
    // to x=4 after clamping and make it appear at the far left of the video.
    const targetItem=[...document.querySelectorAll('.videoOsdHeader .headerRight .headerSectionItem, .headerRight .headerSectionItem')]
      .find(item=>{const r=item.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=innerWidth/2&&r.top>=0&&r.bottom<=innerHeight;});
    const rect=targetItem?.getBoundingClientRect();
    const size=32;
    s.badge.host.style.width=`${size}px`;
    s.badge.host.style.height=`${size}px`;
    const remembered=s.badge.lastPosition;
    const left=rect ? rect.left-size-6 : remembered?.left ?? innerWidth-240;
    const top=rect ? rect.top : remembered?.top ?? 20;
    s.badge.lastPosition={left:Math.max(4,Math.min(left,innerWidth-size-4)),top:Math.max(4,Math.min(top,innerHeight-size-4))};
    s.badge.host.style.left=`${s.badge.lastPosition.left}px`;
    s.badge.host.style.top=`${s.badge.lastPosition.top}px`;
    const fullscreen=document.fullscreenElement || document.webkitFullscreenElement;
    const target=fullscreen && fullscreen!==s.video ? fullscreen : document.documentElement;
    if (s.badge.host.parentElement!==target) target.append(s.badge.host);
  }
  function startBadgeAutoHide(s) {
    const host=s.badge.host;
    const hide=()=>{clearTimeout(s.badge.hideTimer);if(host.dataset.open!=='true')host.dataset.idle='true';};
    const show=()=>{host.dataset.idle='false';clearTimeout(s.badge.hideTimer);s.badge.hideTimer=setTimeout(hide,1800);};
    const inside=(x,y,r)=>r && r.width>0 && r.height>0 && x>=r.left && x<=r.right && y>=r.top && y<=r.bottom;
    const isOverPlayer=(x,y)=>{
      if (inside(x,y,s.video.getBoundingClientRect())) return true;
      const element=document.elementFromPoint(x,y);
      return Boolean(element && (element===host || element.closest?.('.videoOsdHeader, .videoOsdBottom, .videoOsdControls, .videoOsdPositionSlider, .videoOsdVolumeSlider')));
    };
    const move=event=>{if(isOverPlayer(event.clientX,event.clientY))show();else hide();};
    const leave=event=>{if(event.relatedTarget==null)hide();};
    s.badge.activity={hide,move,leave};
    document.addEventListener('mousemove',move,{passive:true});
    document.addEventListener('pointerdown',move,{passive:true});
    document.addEventListener('mouseout',leave);
    window.addEventListener('blur',hide);
    hide();
  }
  function close() {
    if (!session) return;
    clearInterval(session.timer);
    for (const name of session.events) session.video.removeEventListener(name, session.send);
    if (session.badge?.activity) {
      clearTimeout(session.badge.hideTimer);
      document.removeEventListener('mousemove',session.badge.activity.move);
      document.removeEventListener('pointerdown',session.badge.activity.move);
      document.removeEventListener('mouseout',session.badge.activity.leave);
      window.removeEventListener('blur',session.badge.activity.hide);
    }
    session.frame.remove();
    session.badge?.host.remove();
    session = undefined;
  }
  function scan() {
    if (extensionInvalidated) return;
    if (!location.hash.includes("/videoosd/")) { close(); return; }
    const video = [...document.querySelectorAll('video')].find(v => {
      try { const u = new URL(source(v)); return u.origin === location.origin && /\.mkv(?:\?|$)/i.test(u.href); } catch { return false; }
    });
    const url = video && source(video);
    if (session && (session.video !== video || session.url !== url)) close();
    if (!video) return;
    if (session) { positionBadge(session); return; }
    const frame = document.createElement('iframe');
    frame.src = `${new URL('src/audio.html', extensionBaseUrl).href}?parentOrigin=${encodeURIComponent(location.origin)}`;
    frame.allow = 'autoplay';
    frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0';
    const send = (event) => {
      if (!session?.frameReady || !frame.isConnected) return;
      if (event?.type === 'play') session.wanted = true;
      if (event?.type === 'pause') {
        if (session.internalPause) session.internalPause = false;
        else session.wanted = false;
      }
      // Emby or a native control can restart its video element while the audio
      // bridge is still waiting for decoded PCM. Reassert the hold on every
      // sync tick so video cannot continue silently during that wait.
      if (session.buffering && !video.paused && !video.ended && !video.seeking) {
        session.internalPause=true;
        video.pause();
      }
      if (!video.isConnected || source(video) !== url) { close(); return; }
      frame.contentWindow?.postMessage({type:'audio-bridge-state', url,
        time:video.currentTime, duration:video.duration, buffering:session.buffering, held:session.buffering && video.paused, videoPaused:video.paused, paused:!session.wanted || video.ended || video.seeking || (!session.buffering && video.readyState < 3),
        rate:video.playbackRate, volume:video.muted ? 0 : video.volume,
        seeking:video.seeking, stamp:performance.timeOrigin + performance.now()}, extensionOrigin);
    };
    const events = ['play','pause','seeking','seeked','waiting','playing','ended','emptied','ratechange','volumechange'];
    const badge=createBadge();
    session = {video, url, frame, send, events, badge, status:{codec:'probing',phase:'probing-audio'}, frameReady:false, wanted:!video.paused, buffering:false, internalPause:false, timer:setInterval(send, 100)};
    badge.host.dataset.audioBridge='';
    document.documentElement.append(badge.host);
    renderBadge(session);
    positionBadge(session);
    startBadgeAutoHide(session);
    for (const name of events) video.addEventListener(name, send);
    document.documentElement.append(frame);
  }
  window.addEventListener('message', ({origin:from,source:sender,data}) => {
    const s=session;
    if (!s || from!==extensionOrigin || sender!==s.frame.contentWindow) return;
    if (data?.type==='audio-bridge-ready') {
      s.frameReady=true;
      s.send();
      return;
    }
    if (data?.type==='audio-bridge-status') {
      const d=data.status || {};
      s.status={codec:String(d.codec||'probing').slice(0,24),phase:String(d.phase||'idle').slice(0,32),context:String(d.context||'unknown').slice(0,24),decoding:Boolean(d.decoding),audible:Boolean(d.audible),paused:Boolean(d.paused),buffering:Boolean(d.buffering),held:Boolean(d.held),videoPaused:Boolean(d.videoPaused),bufferedAhead:Number(d.bufferedAhead)||0,bufferedBehind:Number(d.bufferedBehind)||0,lastDecodeMs:Number(d.lastDecodeMs)||0,fetched:Number(d.fetched)||0,error:String(d.error||'').slice(0,180),mediaTime:Number(d.mediaTime)||0,decodeStart:Number(d.decodeStart)||0,decodeDuration:Number(d.decodeDuration)||0,pcmSeconds:Number(d.pcmSeconds)||0,cacheChunks:Number(d.cacheChunks)||0,lastJobNetworkMs:Number(d.lastJobNetworkMs)||0,lastJobOtherMs:Number(d.lastJobOtherMs)||0,io:d.io||null,workerLog:String(d.workerLog||'').slice(0,220)};
      renderBadge(s);
      return;
    }
    if (data?.type!=='audio-bridge-buffer') return;
    if (Math.abs(s.video.currentTime-data.time)>.25 || source(s.video)!==s.url) return;
    s.buffering=Boolean(data.wait);
    if (s.buffering && !s.video.paused) { s.internalPause=true; s.video.pause(); }
    if (!s.buffering && s.wanted && s.video.paused) s.video.play().catch(()=>{});
    s.send();
  });
  window.addEventListener('pagehide', close);
  window.addEventListener('hashchange', close);
  window.addEventListener('resize', () => positionBadge());
  window.addEventListener('scroll', () => positionBadge(), true);
  document.addEventListener('fullscreenchange', () => positionBadge());
  scanTimer=setInterval(scan, 500);
})();
