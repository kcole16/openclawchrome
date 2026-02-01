const consoleLogs = new Map();
const networkLogs = new Map();
const recordingState = new Map();

function getLogStore(map, tabId) {
  let list = map.get(tabId);
  if (!list) {
    list = [];
    map.set(tabId, list);
  }
  return list;
}

export function addConsoleLog(tabId, entry) {
  const list = getLogStore(consoleLogs, tabId);
  list.push(entry);
}

export function addNetworkLog(tabId, entry) {
  const list = getLogStore(networkLogs, tabId);
  list.push(entry);
}

async function getViewport(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'enhanced.getViewport' });
  } catch {
    return null;
  }
}

async function sendToContent(tabId, type, params = {}) {
  return await chrome.tabs.sendMessage(tabId, { type, params });
}

function normalizeButton(button) {
  if (button === 'right' || button === 'middle') return button;
  return 'left';
}

function modifiersToMask(modifiers) {
  if (!Array.isArray(modifiers)) return 0;
  let mask = 0;
  for (const m of modifiers) {
    if (m === 'alt') mask |= 1;
    if (m === 'ctrl') mask |= 2;
    if (m === 'meta') mask |= 4;
    if (m === 'shift') mask |= 8;
  }
  return mask;
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

async function dispatchMouse(tabId, params) {
  const debuggee = { tabId };
  return await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', params);
}

async function dispatchKey(tabId, params) {
  const debuggee = { tabId };
  return await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', params);
}

async function dispatchText(tabId, text) {
  const debuggee = { tabId };
  return await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text });
}

async function getPlatform() {
  const info = await chrome.runtime.getPlatformInfo();
  return info?.os || 'unknown';
}

async function selectAll(tabId) {
  const os = await getPlatform();
  const key = os === 'mac' ? 'Meta' : 'Control';
  const keyCode = os === 'mac' ? 'MetaLeft' : 'ControlLeft';
  await dispatchKey(tabId, { type: 'keyDown', key, code: keyCode, modifiers: os === 'mac' ? 4 : 2 });
  await dispatchKey(tabId, { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: os === 'mac' ? 4 : 2, text: 'a' });
  await dispatchKey(tabId, { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: os === 'mac' ? 4 : 2 });
  await dispatchKey(tabId, { type: 'keyUp', key, code: keyCode, modifiers: 0 });
}

async function startRecording(tabId, params) {
  const existing = recordingState.get(tabId);
  if (existing?.timer) return { ok: true, recording: true };

  const intervalMs = Math.max(200, Number(params?.intervalMs || 500));
  const format = params?.format === 'png' ? 'png' : 'jpeg';
  const quality = typeof params?.quality === 'number' ? params.quality : 60;

  const state = {
    frames: [],
    startedAt: Date.now(),
    timer: null,
    format,
    quality
  };

  const capture = async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
      state.frames.push({ ts: Date.now(), data: dataUrl.split(',')[1] });
    } catch {}
  };

  state.timer = setInterval(capture, intervalMs);
  recordingState.set(tabId, state);

  await capture();
  return { ok: true, recording: true };
}

async function stopRecording(tabId) {
  const state = recordingState.get(tabId);
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  return { ok: true, recording: false };
}

async function exportRecording(tabId, params) {
  const state = recordingState.get(tabId);
  if (!state) {
    return { ok: false, error: 'No recording in progress' };
  }

  const payload = {
    format: 'frames',
    width: params?.width || null,
    height: params?.height || null,
    frames: state.frames,
    startedAt: state.startedAt,
    endedAt: Date.now()
  };

  if (params?.download) {
    const filename = params?.filename || 'recording.json';
    const json = JSON.stringify(payload);
    const dataUrl = `data:application/json;base64,${btoa(json)}`;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'enhanced.download',
        params: { filename, dataUrl }
      });
      return { ok: true, downloaded: true, format: 'frames' };
    } catch {
      return { ok: false, error: 'Failed to trigger download' };
    }
  }

  return { ok: true, format: 'frames', data: payload };
}

export async function handleEnhancedCommand({ tabId, method, params }) {
  if (!tabId) throw new Error('No attached tab');

  if (method === 'Enhanced.visualClick') {
    const x = Number(params?.x || 0);
    const y = Number(params?.y || 0);
    const button = normalizeButton(params?.button);
    const clickCount = Math.max(1, Number(params?.clickCount || 1));
    const modifiers = modifiersToMask(params?.modifiers);

    await dispatchMouse(tabId, { type: 'mousePressed', x, y, button, clickCount, modifiers });
    await dispatchMouse(tabId, { type: 'mouseReleased', x, y, button, clickCount, modifiers });
    return { ok: true };
  }

  if (method === 'Enhanced.visualScroll') {
    const x = Number(params?.x || 0);
    const y = Number(params?.y || 0);
    const amount = Math.max(1, Number(params?.amount || 3));
    const direction = params?.direction || 'down';
    let deltaX = 0;
    let deltaY = 0;
    const tick = 100;

    if (direction === 'up') deltaY = -tick * amount;
    if (direction === 'down') deltaY = tick * amount;
    if (direction === 'left') deltaX = -tick * amount;
    if (direction === 'right') deltaX = tick * amount;

    await dispatchMouse(tabId, { type: 'mouseWheel', x, y, deltaX, deltaY });
    return { ok: true };
  }

  if (method === 'Enhanced.visualType') {
    const text = String(params?.text || '');
    const delay = Math.max(0, Number(params?.delay || 0));

    if (params?.clearFirst) {
      await selectAll(tabId);
      await dispatchKey(tabId, { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
      await dispatchKey(tabId, { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
    }

    if (delay === 0) {
      await dispatchText(tabId, text);
    } else {
      for (const ch of text) {
        await dispatchText(tabId, ch);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    return { ok: true };
  }

  if (method === 'Enhanced.screenshot') {
    const format = params?.format === 'png' ? 'png' : 'jpeg';
    const quality = typeof params?.quality === 'number' ? params.quality : 85;

    const tab = await chrome.tabs.get(tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format, quality });
    const viewport = await getViewport(tabId);
    const ratio = viewport?.devicePixelRatio || 1;
    const width = viewport?.width ? Math.round(viewport.width * ratio) : null;
    const height = viewport?.height ? Math.round(viewport.height * ratio) : null;

    return {
      id: randomId('ss'),
      width,
      height,
      format,
      data: dataUrl.split(',')[1]
    };
  }

  if (method === 'Enhanced.getAccessibilityTree') {
    const response = await sendToContent(tabId, 'enhanced.getAccessibilityTree', params || {});
    return response || { tree: [] };
  }

  if (method === 'Enhanced.findElement') {
    const response = await sendToContent(tabId, 'enhanced.findElement', params || {});
    return response || { matches: [] };
  }

  if (method === 'Enhanced.getPageText') {
    const response = await sendToContent(tabId, 'enhanced.getPageText', params || {});
    return response || { title: '', url: '', text: '' };
  }

  if (method === 'Enhanced.getConsoleMessages') {
    const list = [...(consoleLogs.get(tabId) || [])];
    const pattern = params?.pattern ? new RegExp(params.pattern, 'i') : null;
    const onlyErrors = !!params?.onlyErrors;
    let filtered = list;

    if (pattern) {
      filtered = filtered.filter(entry => pattern.test(entry.message || ''));
    }
    if (onlyErrors) {
      filtered = filtered.filter(entry => entry.level === 'error' || entry.level === 'warn');
    }

    const limit = Math.max(1, Number(params?.limit || filtered.length));
    const result = filtered.slice(-limit);

    if (params?.clear) consoleLogs.set(tabId, []);

    return { messages: result };
  }

  if (method === 'Enhanced.getNetworkRequests') {
    const list = [...(networkLogs.get(tabId) || [])];
    const pattern = params?.urlPattern ? new RegExp(params.urlPattern, 'i') : null;
    let filtered = list;

    if (pattern) {
      filtered = filtered.filter(entry => pattern.test(entry.url || ''));
    }

    const limit = Math.max(1, Number(params?.limit || filtered.length));
    const result = filtered.slice(-limit);

    if (params?.clear) networkLogs.set(tabId, []);

    return { requests: result };
  }

  if (method === 'Enhanced.startRecording') {
    return await startRecording(tabId, params || {});
  }

  if (method === 'Enhanced.stopRecording') {
    return await stopRecording(tabId);
  }

  if (method === 'Enhanced.exportRecording') {
    return await exportRecording(tabId, params || {});
  }

  throw new Error(`Unknown enhanced method: ${method}`);
}
