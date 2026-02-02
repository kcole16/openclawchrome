import { handleEnhancedCommand, addConsoleLog, addNetworkLog } from './lib/cdp-enhanced.js';

const DEFAULT_PORT = 18792;

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '...', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' }
};

let relayWs = null;
let relayConnectPromise = null;
let debuggerListenersInstalled = false;
let nextSession = 1;

const tabs = new Map();
const tabBySession = new Map();
const childSessionToTab = new Map();
const pending = new Map();
const detachInitiated = new Set();
const reattachTimers = new Map();
const reattachAttempts = new Map();
const MAX_REATTACH_ATTEMPTS = 5;

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort']);
  const n = Number.parseInt(String(stored.relayPort || ''), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT;
  return n;
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind];
  chrome.action.setBadgeText({ tabId, text: cfg.text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
  chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {});
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;
  if (relayConnectPromise) return await relayConnectPromise;

  relayConnectPromise = (async () => {
    const port = await getRelayPort();

    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000)
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
    relayWs = ws;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket timeout')), 5000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket failed')); };
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`Closed: ${ev.code}`)); };
    });

    ws.onmessage = (e) => onRelayMessage(String(e.data));
    ws.onclose = () => onRelayClosed('closed');
    ws.onerror = () => onRelayClosed('error');

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true;
      chrome.debugger.onEvent.addListener(onDebuggerEvent);
      chrome.debugger.onDetach.addListener(onDebuggerDetach);
    }
  })();

  try {
    await relayConnectPromise;
  } finally {
    relayConnectPromise = null;
  }
}

function sendToRelay(payload) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected');
  }
  relayWs.send(JSON.stringify(payload));
}

function onRelayClosed(reason) {
  relayWs = null;

  for (const [id, p] of pending.entries()) {
    pending.delete(id);
    p.reject(new Error(`Relay disconnected (${reason})`));
  }

  for (const tabId of tabs.keys()) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    setBadge(tabId, 'connecting');
  }

  tabs.clear();
  tabBySession.clear();
  childSessionToTab.clear();
}

async function onRelayMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg?.method === 'ping') {
    try { sendToRelay({ method: 'pong' }); } catch {}
    return;
  }

  if (typeof msg?.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error)));
      else p.resolve(msg.result);
    }
    return;
  }

  if (typeof msg?.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg);
      sendToRelay({ id: msg.id, result });
    } catch (err) {
      sendToRelay({ id: msg.id, error: err.message || String(err) });
    }
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '');
  const params = msg?.params?.params;
  const sessionId = msg?.params?.sessionId;

  let tabId = null;

  if (sessionId) {
    tabId = tabBySession.get(sessionId) || childSessionToTab.get(sessionId);
  }

  if (!tabId && params?.targetId) {
    for (const [id, tab] of tabs.entries()) {
      if (tab.targetId === params.targetId) { tabId = id; break; }
    }
  }

  if (!tabId) {
    for (const [id, tab] of tabs.entries()) {
      if (tab.state === 'connected') { tabId = id; break; }
    }
  }

  if (!tabId) throw new Error(`No attached tab for ${method}`);

  const debuggee = { tabId };

  if (method.startsWith('Enhanced.')) {
    return await handleEnhancedCommand({ tabId, method, params });
  }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable');
      await new Promise(r => setTimeout(r, 50));
    } catch {}
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params);
  }

  if (method === 'Target.createTarget') {
    const url = params?.url || 'about:blank';
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise(r => setTimeout(r, 100));
    const attached = await attachTab(tab.id);
    return { targetId: attached.targetId };
  }

  if (method === 'Target.closeTarget') {
    const targetTabId = params?.targetId
      ? [...tabs.entries()].find(([_, t]) => t.targetId === params.targetId)?.[0]
      : tabId;
    if (targetTabId) {
      try { await chrome.tabs.remove(targetTabId); return { success: true }; }
      catch { return { success: false }; }
    }
    return { success: false };
  }

  if (method === 'Target.activateTarget') {
    const targetTabId = params?.targetId
      ? [...tabs.entries()].find(([_, t]) => t.targetId === params.targetId)?.[0]
      : tabId;
    if (targetTabId) {
      const tab = await chrome.tabs.get(targetTabId).catch(() => null);
      if (tab?.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(targetTabId, { active: true }).catch(() => {});
    }
    return {};
  }

  const debuggerSession = sessionId && tabs.get(tabId)?.sessionId !== sessionId
    ? { ...debuggee, sessionId }
    : debuggee;

  return await chrome.debugger.sendCommand(debuggerSession, method, params);
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId };

  await chrome.debugger.attach(debuggee, '1.3');
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {});

  const info = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
  const targetInfo = info?.targetInfo;
  const targetId = String(targetInfo?.targetId || '');

  if (!targetId) throw new Error('No targetId returned');

  const sessionId = `cb-tab-${nextSession++}`;

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder: nextSession });
  tabBySession.set(sessionId, tabId);

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false
        }
      }
    });
  }

  setBadge(tabId, 'on');
  detachInitiated.delete(tabId);
  const timer = reattachTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    reattachTimers.delete(tabId);
  }
  reattachAttempts.delete(tabId);
  return { sessionId, targetId };
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId);

  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason }
        }
      });
    } catch {}
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId);
  tabs.delete(tabId);

  for (const [childId, parentId] of childSessionToTab.entries()) {
    if (parentId === tabId) childSessionToTab.delete(childId);
  }

  detachInitiated.add(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch {}
  setBadge(tabId, 'off');
}

function cleanupTabState(tabId) {
  const tab = tabs.get(tabId);

  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'detached' }
        }
      });
    } catch {}
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId);
  tabs.delete(tabId);

  for (const [childId, parentId] of childSessionToTab.entries()) {
    if (parentId === tabId) childSessionToTab.delete(childId);
  }
}

function scheduleReattach(tabId) {
  if (reattachTimers.has(tabId)) return;
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;

  const attempts = (reattachAttempts.get(tabId) || 0) + 1;
  if (attempts > MAX_REATTACH_ATTEMPTS) return;
  reattachAttempts.set(tabId, attempts);

  const delay = Math.min(1000 * attempts, 5000);
  const timer = setTimeout(async () => {
    reattachTimers.delete(tabId);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return;
      await attachTab(tabId, { skipAttachedEvent: false });
    } catch {
      scheduleReattach(tabId);
    }
  }, delay);

  reattachTimers.set(tabId, timer);
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (!tabId) return;

  const tab = tabs.get(tabId);
  if (!tab?.sessionId) return;

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId);
  }
  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId));
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params
      }
    });
  } catch {}
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId;
  if (!tabId) return;

  const wasInitiated = detachInitiated.has(tabId);

  if (reason === 'toggle' || wasInitiated) {
    if (tabs.has(tabId)) {
      detachTab(tabId, reason);
    }
    return;
  }

  cleanupTabState(tabId);
  setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? 'connecting' : 'off');
  console.warn('Debugger detached, attempting reattach:', reason);
  scheduleReattach(tabId);
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = active?.id;
  if (!tabId) return;

  const existing = tabs.get(tabId);
  if (existing?.state === 'connected') {
    await detachTab(tabId, 'toggle');
    return;
  }

  tabs.set(tabId, { state: 'connecting' });
  setBadge(tabId, 'connecting');

  try {
    await ensureRelayConnection();
    await attachTab(tabId);
  } catch (err) {
    tabs.delete(tabId);
    setBadge(tabId, 'error');
    console.warn('Attach failed:', err.message);
  }
}

chrome.action.onClicked.addListener(() => connectOrToggleForActiveTab());

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender?.tab?.id;
  if (!tabId || !msg?.type) return;

  if (msg.type === 'enhanced.console') {
    addConsoleLog(tabId, msg.payload);
  }

  if (msg.type === 'enhanced.network') {
    addNetworkLog(tabId, msg.payload);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.openOptionsPage();
});
