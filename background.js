// Clippy service worker: the single writer for chrome.storage.local, plus
// keyboard commands and context menus. Content scripts and the popup read
// storage directly but send every change here as a message.

importScripts('lib/cleanup.js', 'lib/defaults.js');

const SAMPLE_SNIPPETS = [
  {
    name: "Today's date",
    trigger: 'date',
    body: '{{date:dddd, D MMMM YYYY}}',
    tags: ['basics'],
    sites: [],
  },
  {
    name: 'Meeting follow-up',
    trigger: 'fu',
    body: 'Hi {{input:Name}},\n\nThanks for your time {{select:When|today|yesterday|earlier this week}}. As discussed, {{cursor}}\n\nBest,',
    tags: ['email'],
    sites: ['mail.google.com', 'outlook.office.com'],
  },
  {
    name: 'Bug report',
    trigger: 'bug',
    body: '**Steps to reproduce**\n1. {{cursor}}\n\n**Expected**\n\n**Actual**\n\n**Environment**\n{{url}} · {{date}}',
    tags: ['dev'],
    sites: ['github.com', '*.atlassian.net', 'linear.app'],
  },
  {
    name: 'Quote clipboard',
    trigger: 'qc',
    body: '> {{clipboard}}\n\n{{cursor}}',
    tags: ['basics'],
    sites: [],
  },
  {
    name: 'Markdown link to this page',
    trigger: 'link',
    body: '[{{title}}]({{url}})',
    tags: ['dev'],
    sites: [],
  },
];

async function readState() {
  const s = await chrome.storage.local.get(['snippets', 'history', 'settings']);
  return {
    snippets: s.snippets || [],
    history: s.history || [],
    settings: Clippy.withDefaults(s.settings),
  };
}

// Serialise all writes so concurrent messages from several tabs can't
// overwrite each other.
let writeQueue = Promise.resolve();
function mutate(fn) {
  const run = writeQueue.then(async () => {
    const state = await readState();
    const result = await fn(state);
    await chrome.storage.local.set(state);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

function trimHistory(history, limit) {
  let unpinned = 0;
  return history.filter((h) => h.pinned || ++unpinned <= limit);
}

function normaliseSnippet(input, existing) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    id: existing?.id || input.id || crypto.randomUUID(),
    name: String(input.name || '').trim() || 'Untitled snippet',
    trigger: String(input.trigger || '').trim().replace(/\s+/g, ''),
    body: String(input.body || ''),
    tags: list(input.tags),
    sites: list(input.sites),
    uses: existing?.uses || input.uses || 0,
    siteUses: existing?.siteUses || input.siteUses || {},
    updatedAt: Date.now(),
  };
}

const handlers = {
  'history:add': (msg, sender) => {
    if (sender.tab?.incognito) return { ok: false, reason: 'incognito' };
    const text = String(msg.text || '');
    if (!text.trim() || text.length > 100000) return { ok: false };
    return mutate((state) => {
      if (!state.settings.recording) return { ok: false, reason: 'paused' };
      const { history } = state;
      const idx = history.findIndex((h) => h.text === text);
      let pinned = false;
      if (idx === 0) {
        history[0].at = Date.now();
        return { ok: true };
      }
      if (idx > 0) pinned = history.splice(idx, 1)[0].pinned;
      history.unshift({
        id: crypto.randomUUID(),
        text,
        sourceUrl: msg.sourceUrl || sender.tab?.url || '',
        sourceTitle: msg.sourceTitle || sender.tab?.title || '',
        at: Date.now(),
        pinned,
      });
      state.history = trimHistory(history, state.settings.historyLimit);
      return { ok: true };
    });
  },

  'history:pin': (msg) =>
    mutate(({ history }) => {
      const h = history.find((x) => x.id === msg.id);
      if (h) h.pinned = !!msg.pinned;
    }),

  'history:delete': (msg) =>
    mutate((state) => {
      state.history = state.history.filter((h) => h.id !== msg.id);
    }),

  'history:clear': () =>
    mutate((state) => {
      state.history = state.history.filter((h) => h.pinned);
    }),

  'snippet:save': (msg) =>
    mutate((state) => {
      const existing = state.snippets.find((s) => s.id === msg.snippet.id);
      const snippet = normaliseSnippet(msg.snippet, existing);
      const clash = snippet.trigger && state.snippets.find((s) => s.trigger === snippet.trigger && s.id !== snippet.id);
      if (clash) return { ok: false, error: `Trigger "${snippet.trigger}" is already used by "${clash.name}".` };
      if (existing) Object.assign(existing, snippet);
      else state.snippets.unshift(snippet);
      return { ok: true, snippet };
    }),

  'snippet:delete': (msg) =>
    mutate((state) => {
      state.snippets = state.snippets.filter((s) => s.id !== msg.id);
    }),

  'snippet:use': (msg) =>
    mutate(({ snippets }) => {
      const s = snippets.find((x) => x.id === msg.id);
      if (!s) return;
      s.uses = (s.uses || 0) + 1;
      if (msg.host) {
        s.siteUses = s.siteUses || {};
        s.siteUses[msg.host] = (s.siteUses[msg.host] || 0) + 1;
      }
    }),

  'settings:save': (msg) =>
    mutate((state) => {
      state.settings = { ...state.settings, ...msg.settings };
      state.history = trimHistory(state.history, state.settings.historyLimit);
    }),

  // data: { snippets?, history?, settings? } from an export file.
  'data:import': (msg) =>
    mutate((state) => {
      const data = msg.data || {};
      let added = 0;
      const triggers = new Set(state.snippets.map((s) => s.trigger).filter(Boolean));
      const ids = new Set(state.snippets.map((s) => s.id));
      for (const raw of Array.isArray(data.snippets) ? data.snippets : []) {
        if (!raw || typeof raw.body !== 'string') continue;
        const s = normaliseSnippet({ ...raw, id: ids.has(raw.id) ? undefined : raw.id });
        if (s.trigger && triggers.has(s.trigger)) s.trigger = '';
        if (s.trigger) triggers.add(s.trigger);
        ids.add(s.id);
        state.snippets.push(s);
        added++;
      }
      return { ok: true, added };
    }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

// --- install: defaults, sample snippets, context menus ---

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await mutate((state) => {
      if (!state.snippets.length) state.snippets = SAMPLE_SNIPPETS.map((s) => normaliseSnippet(s));
    });
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-selection', title: 'Save selection as Clippy snippet', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'open-palette', title: 'Insert Clippy snippet…', contexts: ['editable'] });
  });
});

function sendToTab(tabId, message, frameId) {
  const opts = frameId === undefined ? undefined : { frameId };
  return chrome.tabs.sendMessage(tabId, message, opts).catch(() => null); // no content script (chrome:// etc.)
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'open-palette') {
    sendToTab(tab.id, { type: 'open-palette', force: true }, info.frameId);
    return;
  }
  if (info.menuItemId === 'save-selection') {
    // info.selectionText flattens newlines; ask the frame for the real text.
    const res = await sendToTab(tab.id, { type: 'get-selection' }, info.frameId);
    const body = res?.text || info.selectionText || '';
    await chrome.storage.session.set({ draft: { body, sites: [], fromUrl: tab.url || '' } });
    try {
      await chrome.action.openPopup();
    } catch {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?full=1') });
    }
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id && (command === 'open-palette' || command === 'paste-clean')) {
    sendToTab(tab.id, { type: command });
  }
});
