let nextRef = 1;
const elementRefs = new WeakMap();
let consoleWrapped = false;
let networkWrapped = false;

function getRef(el) {
  let ref = elementRefs.get(el);
  if (!ref) {
    ref = `ref_${nextRef++}`;
    elementRefs.set(el, ref);
  }
  return ref;
}

function getRole(el) {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' && el.getAttribute('href')) return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button') return 'button';
    return 'textbox';
  }
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'img') return 'img';
  if (tag === 'form') return 'form';
  return 'generic';
}

function getName(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const ids = labelledBy.split(/\s+/).filter(Boolean);
    const text = ids
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .map(node => node.textContent || '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) return placeholder.trim();
  const alt = el.getAttribute('alt');
  if (alt) return alt.trim();
  const text = (el.textContent || '').trim();
  if (text) return text.slice(0, 200);
  return '';
}

function getValue(el) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return String(el.value || '');
  }
  return null;
}

function isInteractive(el) {
  const tag = el.tagName.toLowerCase();
  if (el.hasAttribute('contenteditable')) return true;
  if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'input' && (el.getAttribute('type') || 'text') !== 'hidden') return true;
  if (tag === 'a' && el.getAttribute('href')) return true;
  const role = el.getAttribute('role');
  return !!role && /button|link|textbox|checkbox|radio|switch|combobox|menuitem|tab|option/i.test(role);
}

function buildNode(el, depth, filter) {
  const rect = el.getBoundingClientRect();
  const node = {
    ref: getRef(el),
    role: getRole(el),
    name: getName(el),
    value: getValue(el),
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    interactive: isInteractive(el),
    children: []
  };

  if (depth <= 0) return node;

  for (const child of Array.from(el.children)) {
    const childNode = buildNode(child, depth - 1, filter);
    if (filter === 'interactive') {
      if (childNode.interactive || childNode.children.length > 0) {
        node.children.push(childNode);
      }
    } else if (filter === 'form') {
      if (childNode.role === 'textbox' || childNode.role === 'combobox' || childNode.role === 'form' || childNode.role === 'button') {
        node.children.push(childNode);
      }
    } else {
      node.children.push(childNode);
    }
  }

  return node;
}

function trimTreeByChars(tree, maxChars) {
  if (!maxChars || maxChars <= 0) return tree;
  let count = 0;

  function walk(node) {
    const base = `${node.ref}${node.role}${node.name}${node.value || ''}`;
    count += base.length;
    if (count > maxChars) {
      node.children = [];
      return false;
    }
    for (const child of node.children) {
      if (!walk(child)) return false;
    }
    return true;
  }

  for (const node of tree) {
    if (!walk(node)) break;
  }

  return tree;
}

function scoreElement(queryTokens, node) {
  const hay = `${node.role} ${node.name} ${node.value || ''}`.toLowerCase();
  let score = 0;
  for (const t of queryTokens) {
    if (hay.includes(t)) score += 1;
  }
  if (node.interactive) score += 0.5;
  return score;
}

function findElements(query, maxResults) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  const walk = (el) => {
    const node = buildNode(el, 0, 'all');
    const score = scoreElement(tokens, node);
    if (score > 0) {
      results.push({
        ref: node.ref,
        role: node.role,
        name: node.name,
        confidence: Math.min(1, score / Math.max(1, tokens.length)),
        bounds: node.bounds
      });
    }
    for (const child of Array.from(el.children)) walk(child);
  };

  walk(document.body || document.documentElement);

  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, maxResults);
}

function extractPageText(maxChars) {
  const title = document.title || '';
  const url = location.href;
  let text = (document.body && document.body.innerText) ? document.body.innerText : '';
  text = text.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
  if (maxChars && text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  return { title, url, text };
}

function sendLog(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, payload });
  } catch {}
}

function wrapConsole() {
  if (consoleWrapped) return;
  consoleWrapped = true;

  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const original = console[level];
    console[level] = (...args) => {
      const message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(' ');
      sendLog('enhanced.console', {
        level,
        message,
        timestamp: Date.now()
      });
      return original.apply(console, args);
    };
  }

  window.addEventListener('error', (event) => {
    sendLog('enhanced.console', {
      level: 'error',
      message: event.message || 'Script error',
      timestamp: Date.now()
    });
  });
}

function wrapNetwork() {
  if (networkWrapped) return;
  networkWrapped = true;

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const started = Date.now();
    try {
      const response = await originalFetch(...args);
      sendLog('enhanced.network', {
        url: response.url,
        method: (args[1] && args[1].method) || 'GET',
        status: response.status,
        ok: response.ok,
        timestamp: Date.now(),
        durationMs: Date.now() - started
      });
      return response;
    } catch (err) {
      sendLog('enhanced.network', {
        url: (args[0] && args[0].toString()) || '',
        method: (args[1] && args[1].method) || 'GET',
        status: 0,
        ok: false,
        error: String(err),
        timestamp: Date.now(),
        durationMs: Date.now() - started
      });
      throw err;
    }
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__enhanced = { method, url, started: Date.now() };
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('loadend', () => {
      const info = this.__enhanced || {};
      sendLog('enhanced.network', {
        url: info.url || '',
        method: info.method || 'GET',
        status: this.status || 0,
        ok: this.status >= 200 && this.status < 400,
        timestamp: Date.now(),
        durationMs: info.started ? Date.now() - info.started : null
      });
    });
    return originalSend.apply(this, args);
  };
}

wrapConsole();
wrapNetwork();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'enhanced.getViewport') {
    sendResponse({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    });
    return;
  }

  if (msg.type === 'enhanced.getAccessibilityTree') {
    const depth = Number(msg.params?.depth || 10);
    const filter = msg.params?.filter || 'all';
    const maxChars = Number(msg.params?.maxChars || 0);

    const root = document.body || document.documentElement;
    const tree = root ? [buildNode(root, depth, filter)] : [];
    sendResponse({ tree: trimTreeByChars(tree, maxChars) });
    return true;
  }

  if (msg.type === 'enhanced.findElement') {
    const query = String(msg.params?.query || '').trim();
    const maxResults = Math.max(1, Number(msg.params?.maxResults || 5));
    if (!query) {
      sendResponse({ matches: [] });
      return;
    }
    const matches = findElements(query, maxResults);
    sendResponse({ matches });
    return true;
  }

  if (msg.type === 'enhanced.getPageText') {
    const maxChars = Number(msg.params?.maxChars || 50000);
    sendResponse(extractPageText(maxChars));
    return true;
  }

  if (msg.type === 'enhanced.download') {
    const filename = msg.params?.filename || 'recording.json';
    const dataUrl = msg.params?.dataUrl || '';
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    link.style.display = 'none';
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    sendResponse({ ok: true });
    return;
  }
});
