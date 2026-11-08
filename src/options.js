import { DEFAULT_AUDIO_SETTINGS, normalizeAudioSettings } from './settings.js';

const SERVER_KEY = 'servers';
const AUDIO_SETTINGS_KEY = 'audioSettings';
const button = document.querySelector('#run');
const summary = document.querySelector('#summary');
const results = document.querySelector('#results');
const serverForm = document.querySelector('#server-form');
const serverInput = document.querySelector('#server-url');
const serverStatus = document.querySelector('#server-status');
const serverList = document.querySelector('#server-list');
const audioSettingsForm = document.querySelector('#audio-settings-form');
const audioSettingsStatus = document.querySelector('#audio-settings-status');

function showAudioSettings(settings) {
  const value = normalizeAudioSettings({...DEFAULT_AUDIO_SETTINGS,...settings});
  for (const [key, setting] of Object.entries(value)) {
    const control=audioSettingsForm.elements.namedItem(key);
    if (control.type==='checkbox') control.checked=setting;
    else control.value=setting;
  }
}

chrome.storage.local.get(AUDIO_SETTINGS_KEY).then(({audioSettings}) => showAudioSettings(audioSettings));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[AUDIO_SETTINGS_KEY]) showAudioSettings(changes[AUDIO_SETTINGS_KEY].newValue);
});

audioSettingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!audioSettingsForm.reportValidity()) return;
  const values = Object.fromEntries(new FormData(audioSettingsForm));
  values.showStatusBar=audioSettingsForm.elements.namedItem('showStatusBar').checked;
  const settings = normalizeAudioSettings(values);
  try {
    await chrome.storage.local.set({[AUDIO_SETTINGS_KEY]: settings});
    showAudioSettings(settings);
    audioSettingsStatus.textContent = '设置已保存，将立即应用于当前播放和后续播放。';
  } catch (error) {
    audioSettingsStatus.textContent = `保存失败：${error.message || error}`;
  }
});

function patternFromInput(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('请输入有效的 http 或 https Emby 地址');
  }
  return `${url.protocol}//${url.hostname}/*`;
}

function scriptId(pattern) {
  return `eab-${btoa(pattern).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

async function registerSite(pattern) {
  const id = scriptId(pattern);
  const current = await chrome.scripting.getRegisteredContentScripts({ids: [id]});
  if (current.length) return;
  await chrome.scripting.registerContentScripts([{
    id,
    matches: [pattern],
    js: ['src/content.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true
  }]);
}

async function savedServers() {
  const result = await chrome.storage.local.get(SERVER_KEY);
  return Array.isArray(result[SERVER_KEY]) ? result[SERVER_KEY] : [];
}

async function renderServers() {
  serverList.replaceChildren();
  for (const pattern of await savedServers()) {
    const row = document.createElement('li');
    row.className = 'server-row';
    const label = document.createElement('span');
    label.textContent = pattern.slice(0, -2);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = '移除';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await chrome.scripting.unregisterContentScripts({ids: [scriptId(pattern)]}).catch(() => {});
        await chrome.permissions.remove({origins: [pattern]});
        const remaining = (await savedServers()).filter(item => item !== pattern);
        await chrome.storage.local.set({[SERVER_KEY]: remaining});
        serverStatus.textContent = '服务器已移除，相关站点权限也已撤销。';
        await renderServers();
      } catch (error) {
        serverStatus.textContent = `移除失败：${error.message || error}`;
        remove.disabled = false;
      }
    });
    row.append(label, remove);
    serverList.append(row);
  }
}

serverForm.addEventListener('submit', event => {
  event.preventDefault();
  let pattern;
  try {
    pattern = patternFromInput(serverInput.value);
  } catch (error) {
    serverStatus.textContent = error.message;
    return;
  }

  // Request directly from the submit gesture so Chrome can show its permission prompt.
  const permissionRequest = chrome.permissions.request({origins: [pattern]});
  serverStatus.textContent = '等待 Chrome 的站点权限确认…';
  (async () => {
    try {
      if (!await permissionRequest) throw new Error('未授予站点权限');
      await registerSite(pattern);
      const servers = await savedServers();
      if (!servers.includes(pattern)) servers.push(pattern);
      await chrome.storage.local.set({[SERVER_KEY]: servers});
      serverStatus.textContent = '服务器已添加。请刷新该 Emby 页面后播放。';
      serverInput.value = '';
      await renderServers();
    } catch (error) {
      serverStatus.textContent = `添加失败：${error.message || error}`;
    }
  })();
});

async function checkWorkerDecoder() {
  const worker = new Worker('decode-worker.js', {type: 'module'});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('初始化超过 90 秒')), 90000);
      worker.onmessage = ({data}) => {
        if (data.type === 'log' || data.type === 'io' || data.type === 'progress') return;
        if (data.id !== 1) return;
        clearTimeout(timer);
        if (data.type === 'error') reject(new Error(data.data?.message || 'Worker 初始化失败'));
        else resolve(data.data);
      };
      worker.onerror = event => {
        clearTimeout(timer);
        reject(new Error(event.message || '解码 Worker 启动失败'));
      };
      worker.postMessage({id: 1, type: 'init', data: {
        coreURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')
      }});
    });
  } finally {
    worker.terminate();
  }
}

function add(label, state, detail = '') {
  const row = document.createElement('li');
  row.dataset.state = state;
  row.textContent = detail ? `${label}：${detail}` : label;
  results.append(row);
}

button.addEventListener('click', async () => {
  button.disabled = true;
  results.replaceChildren();
  summary.textContent = '正在检测…首次加载内置解码器可能需要一点时间。';
  let failed = false;
  const record = (label, check) => Promise.resolve().then(check)
    .then(detail => add(label, 'pass', detail))
    .catch(error => {
      failed = true;
      add(label, 'fail', error.message || String(error));
    });

  try {
    await record('浏览器音频输出', async () => {
      if (!window.AudioContext) throw new Error('AudioContext 不可用');
      const context = new AudioContext();
      try {
        await context.resume();
        if (context.state !== 'running') throw new Error(`音频上下文状态：${context.state}`);
        return 'AudioContext 已运行（无法检测系统静音或实际扬声器）';
      } finally {
        await context.close();
      }
    });

    add('扩展版本', 'pass', chrome.runtime.getManifest().version);
    await record('FFmpeg JS 文件', async () => {
      const response = await fetch(chrome.runtime.getURL('vendor/core/ffmpeg-core.js'));
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
      return '可读取';
    });
    await record('FFmpeg WASM 文件', async () => {
      const response = await fetch(chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm'));
      if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
      const header = response.headers.get('content-length');
      const bytes = header === null ? NaN : Number(header);
      if (Number.isFinite(bytes) && bytes < 1024 * 1024) throw new Error(`文件大小异常（${bytes} 字节）`);
      return Number.isFinite(bytes) ? `${(bytes / 1024 / 1024).toFixed(1)} MB，可读取` : '可读取；浏览器未提供文件大小';
    });
    if (typeof Worker !== 'function') {
      failed = true;
      add('浏览器 Worker', 'fail', '此浏览器不支持 Web Worker');
    } else add('浏览器 Worker', 'pass', '可用');

    await record('内置 FFmpeg 解码器', async () => {
      await checkWorkerDecoder();
      return 'FFmpeg 与 WASM 已成功初始化';
    });

    await record('Emby 站点权限', async () => {
      const servers = await savedServers();
      if (!servers.length) throw new Error('尚未添加 Emby 服务器');
      for (const pattern of servers) {
        if (await chrome.permissions.contains({origins: [pattern]})) {
          await registerSite(pattern);
          return `已授权并启用：${pattern.slice(0, -2)}`;
        }
      }
      throw new Error('已配置服务器，但站点权限未授予；请重新添加服务器');
    });
  } catch (error) {
    failed = true;
    add('检测流程', 'fail', error.message || String(error));
  } finally {
    summary.textContent = failed ? '检测发现问题，请查看失败项。' : '检测通过。刷新 Emby 播放页面后重试。';
    button.disabled = false;
  }
});

async function restoreContentScripts() {
  for (const pattern of await savedServers()) {
    if (await chrome.permissions.contains({origins: [pattern]})) {
      await registerSite(pattern).catch(error => {
        serverStatus.textContent = `恢复站点脚本失败：${error.message || error}`;
      });
    }
  }
  await renderServers();
}

restoreContentScripts().catch(error => {
  serverStatus.textContent = `读取服务器配置失败：${error.message || error}`;
});
