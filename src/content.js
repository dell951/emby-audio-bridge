(() => {
  const origin = new URL(chrome.runtime.getURL('/')).origin;
  let session;
  const source = v => v.currentSrc || v.src || v.querySelector('source')?.src;
  function close() {
    if (!session) return;
    clearInterval(session.timer);
    for (const name of session.events) session.video.removeEventListener(name, session.send);
    session.frame.remove();
    session = undefined;
  }
  function scan() {
    if (!location.hash.includes("/videoosd/")) { close(); return; }
    const video = [...document.querySelectorAll('video')].find(v => {
      try { const u = new URL(source(v)); return u.origin === location.origin && /\.mkv(?:\?|$)/i.test(u.href); } catch { return false; }
    });
    const url = video && source(video);
    if (session && (session.video !== video || session.url !== url)) close();
    if (!video || session) return;
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('src/audio.html');
    frame.allow = 'autoplay';
    frame.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0';
    const send = (event) => {
      if (event?.type === 'play') session.wanted = true;
      if (event?.type === 'pause') {
        if (session.internalPause) session.internalPause = false;
        else session.wanted = false;
      }
      if (!video.isConnected || source(video) !== url) { close(); return; }
      frame.contentWindow?.postMessage({type:'audio-bridge-state', url,
        time:video.currentTime, duration:video.duration, buffering:session.buffering, paused:!session.wanted || video.ended || video.seeking || (!session.buffering && video.readyState < 3),
        rate:video.playbackRate, volume:video.muted ? 0 : video.volume,
        seeking:video.seeking, stamp:performance.timeOrigin + performance.now()}, origin);
    };
    const events = ['play','pause','seeking','seeked','waiting','playing','ended','emptied','ratechange','volumechange'];
    session = {video, url, frame, send, events, wanted:!video.paused, buffering:false, internalPause:false, timer:setInterval(send, 100)};
    for (const name of events) video.addEventListener(name, send);
    frame.addEventListener('load', send);
    document.documentElement.append(frame);
  }
  window.addEventListener('message', ({origin:from,source:sender,data}) => {
    const s=session;
    if (!s || from!==origin || sender!==s.frame.contentWindow || data?.type!=='audio-bridge-buffer') return;
    if (Math.abs(s.video.currentTime-data.time)>.25 || source(s.video)!==s.url) return;
    s.buffering=Boolean(data.wait);
    if (s.buffering && !s.video.paused) { s.internalPause=true; s.video.pause(); }
    if (!s.buffering && s.wanted && s.video.paused) s.video.play().catch(()=>{});
    s.send();
  });
  window.addEventListener('pagehide', close);
  window.addEventListener('hashchange', close);
  setInterval(scan, 500);
})();
