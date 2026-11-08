const SERVER_KEY = 'servers';

function scriptId(pattern) {
  return `eab-${btoa(pattern).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

let restoreTask;

async function restoreContentScripts() {
  const { [SERVER_KEY]: servers = [] } = await chrome.storage.local.get(SERVER_KEY);
  if (!Array.isArray(servers)) return;

  for (const pattern of servers) {
    if (typeof pattern !== 'string' || !/^https?:\/\/[^/]+\/\*$/.test(pattern)) continue;
    if (!await chrome.permissions.contains({ origins: [pattern] })) continue;

    const id = scriptId(pattern);
    const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (registered) continue;

    await chrome.scripting.registerContentScripts([{
      id,
      matches: [pattern],
      js: ['src/content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  }
}

function scheduleRestore() {
  restoreTask = (restoreTask || Promise.resolve())
    .then(restoreContentScripts)
    .catch(error => console.error('Emby Audio Bridge: content script restore failed', error));
}

chrome.runtime.onInstalled.addListener(scheduleRestore);
chrome.runtime.onStartup.addListener(scheduleRestore);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SERVER_KEY]) scheduleRestore();
});

scheduleRestore();
