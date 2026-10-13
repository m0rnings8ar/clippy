// Clippy content script: records copies, shows the snippet palette, expands
// ;triggers and inserts text into whatever field had focus.
(() => {
  if (window.__clippyLoaded) return;
  window.__clippyLoaded = true;

  const C = globalThis.Clippy;
  const host = location.hostname;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const PASTE_KEY = isMac ? '⌘V' : 'Ctrl+V';
  const CURSOR_MARK = '';

  // ---------------------------------------------------------------- state

  const state = { snippets: [], history: [], settings: C.withDefaults() };
  const ready = chrome.storage.local.get(['snippets', 'history', 'settings']).then((s) => {
    state.snippets = s.snippets || [];
    state.history = s.history || [];
    state.settings = C.withDefaults(s.settings);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.snippets) state.snippets = changes.snippets.newValue || [];
    if (changes.history) state.history = changes.history.newValue || [];
    if (changes.settings) state.settings = C.withDefaults(changes.settings.newValue);
  });

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension was reloaded; this script is orphaned
    }
  }

  const getSnippetBody = (trigger) => state.snippets.find((s) => s.trigger === trigger)?.body;

  // ------------------------------------------------------------- elements

  const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email']);

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isTextControl(el) {
    if (!el || el.disabled || el.readOnly) return false;
    return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_TYPES.has(el.type));
  }

  const isEditable = (el) => isTextControl(el) || !!(el && el.isContentEditable);

  function isSecretField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    return el.type === 'password' || /cc-|one-time-code|password/.test(el.autocomplete || '');
  }

  function selectionRange(el) {
    try {
      return el.selectionStart == null ? null : [el.selectionStart, el.selectionEnd];
    } catch {
      return null; // e.g. type=email has no selection API
    }
  }

  function selectedText(el) {
    if (isTextControl(el)) {
      const r = selectionRange(el);
      return r ? el.value.slice(r[0], r[1]) : '';
    }
    return String(getSelection() || '');
  }

  // Remember where the caret was so we can insert there after the palette closes.
  function captureTarget() {
    const el = deepActiveElement();
    if (!isEditable(el)) return { el: null, selection: String(getSelection() || '') };
    if (isTextControl(el)) {
      const r = selectionRange(el);
      return { el, start: r ? r[0] : null, end: r ? r[1] : null, selection: selectedText(el) };
    }
    const sel = getSelection();
    return { el, range: sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null, selection: sel.toString() };
  }

  function restoreTarget(t) {
    if (!t.el || !t.el.isConnected) return;
    t.el.focus({ preventScroll: true });
    if (t.start != null) {
      t.el.setSelectionRange(t.start, t.end);
    } else if (t.range) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(t.range);
    }
  }

  // Insert text at the target, replacing `replaceLen` chars before the caret
  // (used by trigger expansion). Returns false if nothing could be inserted.
  function insertAt(t, text, cursorOffset, replaceLen = 0) {
    const el = t.el;
    if (!el || !el.isConnected) return false;
    restoreTarget(t);

    if (isTextControl(el)) {
      const hasSel = t.start != null;
      const from = hasSel ? Math.max(0, t.start - replaceLen) : null;
      if (hasSel) el.setSelectionRange(from, t.end);
      const before = el.value;
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text); // keeps the undo stack
      } catch {}
      if (!ok || (text && el.value === before)) {
        if (!hasSel) return false;
        el.setRangeText(text, from, t.end, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
      if (hasSel && cursorOffset != null) {
        const c = from + cursorOffset;
        el.setSelectionRange(c, c);
      }
      return true;
    }

    if (el.isContentEditable) {
      const sel = getSelection();
      for (let i = 0; i < replaceLen; i++) sel.modify('extend', 'backward', 'character');
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, text);
      } catch {}
      if (!ok) return false;
      const back = cursorOffset == null ? 0 : text.length - cursorOffset;
      if (back <= 5000) for (let i = 0; i < back; i++) sel.modify('move', 'backward', 'character');
      return true;
    }
    return false;
  }

  // ------------------------------------------------- toast + hidden helpers

  let util = null;
  function utilRoot() {
    if (util && util.host.isConnected) return util.root;
    const hostEl = document.createElement('clippy-util');
    hostEl.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    const root = hostEl.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .toast { position: fixed; right: 16px; bottom: 16px; max-width: min(360px, calc(100vw - 32px));
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; background: #1f2328;
        padding: 10px 14px; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.25);
        opacity: 0; transform: translateY(8px); transition: opacity .15s, transform .15s; pointer-events: none; }
      .toast.show { opacity: 1; transform: none; }
      textarea { position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; }
    </style><div class="toast" role="status" aria-live="polite"></div>`;
    document.documentElement.appendChild(hostEl);
    util = { host: hostEl, root };
    return root;
  }

  let toastTimer = 0;
  function toast(message) {
    const el = utilRoot().querySelector('.toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // With the clipboardRead permission a content script can paste into its own
  // textarea, which reads the system clipboard (including copies from other
  // apps) without a permission prompt. Steals focus; callers restore it.
  function readSystemClipboard(container) {
    const ta = document.createElement('textarea');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
    ta.addEventListener('paste', (e) => e.stopPropagation());
    (container || utilRoot()).appendChild(ta);
    ta.focus({ preventScroll: true });
    let ok = false;
    try {
      ok = document.execCommand('paste');
    } catch {}
    const value = ta.value;
    ta.remove();
    return ok && value ? value : null;
  }

  // Lazily-read clipboard: only touched if a template uses {{clipboard}}.
  function lazyClipboard() {
    let value;
    return () => {
      if (value === undefined) value = readSystemClipboard() ?? state.history[0]?.text ?? '';
      return value;
    };
  }

  let suppressCopy = false;
  async function copyText(text) {
    suppressCopy = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      utilRoot().appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } finally {
      setTimeout(() => (suppressCopy = false), 50);
    }
  }

  // -------------------------------------------------------- copy capture

  async function record(text) {
    await ready;
    const s = state.settings;
    if (!text || !text.trim() || !s.recording || chrome.extension.inIncognitoContext) return;
    if (C.hostMatchesAny(host, s.excludedHosts)) return;
    if (s.skipSensitive) {
      const reason = C.detectSensitive(text);
      if (reason) {
        toast(`Clippy didn't save this copy: it looks like ${/^[aeiou]/i.test(reason) ? 'an' : 'a'} ${reason}.`);
        return;
      }
    }
    send({ type: 'history:add', text, sourceUrl: location.href, sourceTitle: document.title });
  }

  // Capture phase reads the selection; bubble phase picks up text a page
  // wrote via clipboardData.setData() (e.g. "copy as markdown" features).
  let pendingCopy = null;
  const isOurs = (e) => e.composedPath().some((n) => n === util?.host || n === palette?.host);

  function onCopyCapture(e) {
    if (suppressCopy || isOurs(e)) return;
    const el = deepActiveElement();
    pendingCopy = isSecretField(el) ? { skip: true } : { text: selectedText(el) };
    setTimeout(() => {
      const p = pendingCopy;
      pendingCopy = null;
      if (p && !p.skip) record(p.text);
    }, 0);
  }

  function onCopyBubble(e) {
    if (!pendingCopy || pendingCopy.skip || !e.defaultPrevented || !e.clipboardData) return;
    const t = e.clipboardData.getData('text/plain');
    if (t) pendingCopy.text = t;
  }

  for (const type of ['copy', 'cut']) {
    window.addEventListener(type, onCopyCapture, true);
    window.addEventListener(type, onCopyBubble, false);
  }

  // navigator.clipboard.writeText() calls, relayed by page-hook.js.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'clippy-hook') return;
    if (e.data.type === 'writeText' && typeof e.data.text === 'string' && !suppressCopy) record(e.data.text);
  });

  // ------------------------------------------------------------ rendering

  // Render a snippet or history item to final text, applying a cleanup chain
  // and tracking where {{cursor}} ended up.
  function produce(item, { values = {}, cleanup = [], clipboard, selection = '' } = {}) {
    let text;
    let cursorOffset = null;
    if (item.kind === 'snippet') {
      const ctx = {
        now: new Date(),
        selection,
        url: location.href,
        title: document.title,
        host,
        values,
        getSnippet: getSnippetBody,
      };
      Object.defineProperty(ctx, 'clipboard', { get: clipboard, enumerable: true });
      ({ text, cursorOffset } = C.render(item.s.body, ctx));
    } else {
      text = item.h.text;
    }
    if (!cleanup.length) return { text, cursorOffset };
    const marked = cursorOffset == null ? text : text.slice(0, cursorOffset) + CURSOR_MARK + text.slice(cursorOffset);
    const cleaned = C.applyCleanup(marked, cleanup);
    const idx = cleaned.indexOf(CURSOR_MARK);
    return idx === -1 ? { text: cleaned, cursorOffset: null } : { text: cleaned.replace(CURSOR_MARK, ''), cursorOffset: idx };
  }

  // Insert, or fall back to the clipboard when there is nowhere to type.
  async function deliver(target, out, { copy = false, replaceLen = 0 } = {}) {
    if (copy) {
      await copyText(out.text);
      toast('Copied to clipboard.');
      return;
    }
    if (!insertAt(target, out.text, out.cursorOffset, replaceLen)) {
      restoreTarget(target);
      await copyText(out.text);
      toast(`Copied. Press ${PASTE_KEY} to paste.`);
    }
  }

  // ---------------------------------------------------------------- palette

  let palette = null;

  const PALETTE_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; justify-content: center; align-items: flex-start;
      padding: 12vh 16px 16px; background: rgba(15, 18, 22, .28);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg);
      --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #e3e6ea; --hover: #f3f5f7; --active: #e8f0fe; --accent: #2563eb; --chip: #eef2f7; }
    @media (prefers-color-scheme: dark) {
      .backdrop { --bg: #1c1f24; --fg: #e6e8eb; --muted: #9aa3ad; --line: #30353c; --hover: #262a30; --active: #213252; --accent: #7aa7ff; --chip: #2a2f36; background: rgba(0,0,0,.45); }
    }
    .panel { width: min(760px, 100%); max-height: min(560px, 76vh); display: flex; flex-direction: column; background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 24px 64px rgba(0,0,0,.28); overflow: hidden; }
    .top { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .logo { font-weight: 700; color: var(--accent); letter-spacing: -.01em; }
    input.q { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); font: inherit; font-size: 15px; padding: 4px 2px; }
    .chips { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
    .chip { background: var(--chip); color: var(--fg); border-radius: 999px; padding: 1px 8px; font-size: 11px; white-space: nowrap; }
    .body { display: flex; min-height: 0; flex: 1; }
    .list { flex: 1 1 55%; overflow-y: auto; padding: 6px; min-width: 0; }
    .side { flex: 1 1 45%; border-left: 1px solid var(--line); padding: 10px 12px; overflow: auto; min-width: 0; }
    @media (max-width: 620px) { .side { display: none; } }
    .group { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 8px 8px 4px; }
    .row { display: block; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .row[aria-selected="true"] { background: var(--active); }
    .row:hover:not([aria-selected="true"]) { background: var(--hover); }
    .title { display: flex; gap: 6px; align-items: baseline; }
    .name { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .badge { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); flex: none; }
    .sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check { display: inline-block; width: 18px; color: var(--accent); font-weight: 700; }
    .empty { color: var(--muted); padding: 24px 12px; text-align: center; }
    .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 6px; }
    pre.preview { margin: 0; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
    .caret { color: var(--accent); font-weight: 700; }
    form { padding: 10px 12px; display: grid; gap: 10px; }
    form label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
    form input, form select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
    form input:focus, form select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    .foot { display: flex; gap: 14px; flex-wrap: wrap; padding: 7px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; }
    kbd { font: 11px ui-monospace, Menlo, monospace; background: var(--chip); border-radius: 4px; padding: 0 4px; color: var(--fg); }
  `;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  const firstLine = (t) => (t.split('\n').find((l) => l.trim()) || '').trim();

  async function openPalette({ target = captureTarget(), formFor = null, replaceLen = 0 } = {}) {
    if (palette) {
      palette.input.focus();
      return;
    }
    await ready;

    const hostEl = document.createElement('clippy-palette');
    const root = hostEl.attachShadow({ mode: 'closed' });
    // Keep keystrokes in the palette from triggering page shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'input']) {
      hostEl.addEventListener(type, (e) => e.stopPropagation());
    }

    const input = el('input', { class: 'q', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search' });
    const chips = el('div', { class: 'chips' });
    const list = el('div', { class: 'list', role: 'listbox' });
    const preview = el('pre', { class: 'preview' });
    const sideLabel = el('div', { class: 'label' }, 'Preview');
    const side = el('div', { class: 'side' }, sideLabel, preview);
    const foot = el('div', { class: 'foot' });
    const panel = el(
      'div',
      { class: 'panel', role: 'dialog', 'aria-label': 'Clippy' },
      el('div', { class: 'top' }, el('span', { class: 'logo' }, 'Clippy'), input, chips),
      el('div', { class: 'body' }, list, side),
      foot
    );
    const backdrop = el('div', { class: 'backdrop', onmousedown: (e) => e.target === backdrop && close() }, panel);
    root.append(el('style', {}, PALETTE_CSS), backdrop);
    document.documentElement.appendChild(hostEl);

    // Read the clipboard once, before the search box takes focus.
    const clipValue = readSystemClipboard(root) ?? state.history[0]?.text ?? '';

    palette = {
      host: hostEl,
      input,
      target,
      replaceLen,
      mode: 'list',
      query: '',
      items: [],
      active: 0,
      cleanup: [],
      current: null, // item shown in the preview / used by cleanup mode
      form: null,
    };
    const P = palette;
    const opts = (values = {}) => ({ values, cleanup: P.cleanup, clipboard: () => clipValue, selection: target.selection });

    function close(restore = true) {
      if (palette !== P) return;
      palette = null;
      hostEl.remove();
      if (restore) restoreTarget(target);
    }

    function setFoot(parts) {
      foot.replaceChildren(...parts.map(([k, label]) => el('span', {}, el('kbd', {}, k), ' ', label)));
    }

    function renderChips() {
      chips.replaceChildren(...P.cleanup.map((id) => el('span', { class: 'chip', title: 'Cleanup applied on insert' }, C.TRANSFORMS[id].label)));
    }

    function buildItems() {
      const q = P.query.trim();
      if (P.mode === 'cleanup') {
        return C.rank(q, Object.entries(C.TRANSFORMS), ([id, t]) => [[t.label, 2], [id, 1]]).map(([id, t]) => ({ kind: 'transform', id, t, group: 'Cleanup (applied in order)' }));
      }
      const { snippets, history } = state;
      if (!q) {
        const suggested = C.suggest(snippets, host, 4);
        const seen = new Set(suggested.map((s) => s.id));
        const clips = [...history.filter((h) => h.pinned), ...history.filter((h) => !h.pinned)].slice(0, 8);
        const rest = snippets.filter((s) => !seen.has(s.id)).sort((a, b) => (b.uses || 0) - (a.uses || 0));
        return [
          ...suggested.map((s) => ({ kind: 'snippet', s, group: `Suggested for ${host || 'this page'}` })),
          ...clips.map((h) => ({ kind: 'history', h, group: 'Clipboard history' })),
          ...rest.map((s) => ({ kind: 'snippet', s, group: 'Snippets' })),
        ];
      }
      return [
        ...C.rank(q, snippets, C.snippetFields).slice(0, 30).map((s) => ({ kind: 'snippet', s, group: 'Snippets' })),
        ...C.rank(q, history, C.historyFields).slice(0, 30).map((h) => ({ kind: 'history', h, group: 'Clipboard history' })),
      ];
    }

    function rowFor(item, i) {
      let title;
      let sub;
      if (item.kind === 'snippet') {
        const s = item.s;
        title = [el('span', { class: 'name' }, s.name), s.trigger ? el('span', { class: 'badge' }, state.settings.triggerPrefix + s.trigger) : null];
        sub = [firstLine(s.body).slice(0, 120), s.tags?.length ? ` · ${s.tags.join(', ')}` : ''].join('');
      } else if (item.kind === 'history') {
        const h = item.h;
        const lines = h.text.split('\n').length;
        title = [el('span', { class: 'name' }, (h.pinned ? '📌 ' : '') + firstLine(h.text).slice(0, 140))];
        sub = [hostOf(h.sourceUrl), ago(h.at), lines > 1 ? `${lines} lines` : ''].filter(Boolean).join(' · ');
      } else {
        const pos = P.cleanup.indexOf(item.id);
        title = [el('span', { class: 'check' }, pos === -1 ? '' : String(pos + 1)), el('span', { class: 'name' }, item.t.label)];
        sub = null;
      }
      return el(
        'div',
        {
          class: 'row',
          role: 'option',
          'aria-selected': String(i === P.active),
          onmousemove: () => i !== P.active && setActive(i),
          onclick: (e) => choose(e.shiftKey),
        },
        el('div', { class: 'title' }, title),
        sub ? el('div', { class: 'sub' }, sub) : null
      );
    }

    function renderList() {
      P.items = buildItems();
      P.active = Math.min(P.active, Math.max(0, P.items.length - 1));
      const nodes = [];
      let group = null;
      P.items.forEach((item, i) => {
        if (item.group !== group) {
          group = item.group;
          nodes.push(el('div', { class: 'group' }, group));
        }
        nodes.push(rowFor(item, i));
      });
      if (!P.items.length) {
        nodes.push(el('div', { class: 'empty' }, state.snippets.length || state.history.length ? 'No matches.' : 'Nothing here yet. Copy some text or add a snippet from the toolbar popup.'));
      }
      list.replaceChildren(...nodes);
      updatePreview();
    }

    function setActive(i) {
      const rows = list.querySelectorAll('.row');
      rows[P.active]?.setAttribute('aria-selected', 'false');
      P.active = i;
      const row = rows[i];
      if (row) {
        row.setAttribute('aria-selected', 'true');
        row.scrollIntoView({ block: 'nearest' });
      }
      updatePreview();
    }

    function showPreview(out) {
      const text = out.text.length > 4000 ? out.text.slice(0, 4000) + '…' : out.text;
      if (out.cursorOffset == null || out.cursorOffset > text.length) preview.replaceChildren(text);
      else preview.replaceChildren(text.slice(0, out.cursorOffset), el('span', { class: 'caret' }, '▍'), text.slice(out.cursorOffset));
    }

    function updatePreview() {
      if (P.mode === 'list') P.current = P.items[P.active] || null;
      sideLabel.textContent = P.cleanup.length ? `Preview · ${P.cleanup.length} cleanup${P.cleanup.length > 1 ? 's' : ''}` : 'Preview';
      if (!P.current) return preview.replaceChildren();
      // Show unfilled fields as ‹Label› so the preview reads naturally.
      const values = P.form && Object.fromEntries(Object.entries(P.form.values()).map(([k, v]) => [k, v || `‹${k}›`]));
      showPreview(produce(P.current, opts(values || undefined)));
    }

    function setMode(mode) {
      if (P.mode === 'list') P.listQuery = P.query;
      P.mode = mode;
      P.active = 0;
      P.query = mode === 'list' ? P.listQuery || '' : '';
      input.value = P.query;
      input.placeholder = mode === 'cleanup' ? 'Filter cleanups…' : 'Search snippets and clipboard history…';
      if (mode === 'cleanup') {
        setFoot([['↵', 'toggle'], ['Tab', 'back'], ['Esc', 'back']]);
      } else {
        setFoot([['↵', 'insert'], ['⇧↵', 'copy'], ['Tab', 'cleanup'], ['Esc', 'close']]);
      }
      renderList();
      input.focus();
    }

    // Fill-in form for {{input:…}} / {{select:…}} fields.
    function openForm(item) {
      const fields = C.extractFields(item.s.body, getSnippetBody);
      P.mode = 'form';
      P.current = item;
      const controls = fields.map((f) =>
        f.kind === 'select'
          ? el('select', { 'data-label': f.label }, f.options.map((o) => el('option', { value: o }, o)))
          : el('input', { type: 'text', 'data-label': f.label, placeholder: f.default || f.label, autocomplete: 'off' })
      );
      controls.forEach((c, i) => {
        if (fields[i].kind === 'input' && fields[i].default) c.value = fields[i].default;
        c.addEventListener('input', updatePreview);
        c.addEventListener('change', updatePreview);
      });
      const form = el(
        'form',
        { onsubmit: (e) => e.preventDefault() },
        el('div', { class: 'label' }, item.s.name),
        fields.map((f, i) => el('label', {}, f.label, controls[i]))
      );
      P.form = {
        controls,
        values: () => Object.fromEntries(controls.map((c) => [c.dataset.label, c.value])),
      };
      list.replaceChildren(form);
      setFoot([['↵', 'next / insert'], [isMac ? '⌘↵' : 'Ctrl+↵', 'insert'], ['Esc', 'back']]);
      updatePreview();
      controls[0]?.focus();
    }

    async function finish(item, copy) {
      const values = P.form ? P.form.values() : {};
      const out = produce(item, opts(values));
      close(false);
      if (item.kind === 'snippet') send({ type: 'snippet:use', id: item.s.id, host });
      await deliver(target, out, { copy, replaceLen: P.replaceLen });
    }

    function choose(copy = false) {
      if (P.mode === 'cleanup') {
        const item = P.items[P.active];
        if (!item) return;
        const pos = P.cleanup.indexOf(item.id);
        if (pos === -1) P.cleanup.push(item.id);
        else P.cleanup.splice(pos, 1);
        renderChips();
        renderList();
        return;
      }
      const item = P.mode === 'form' ? P.current : P.items[P.active];
      if (!item) return;
      if (P.mode === 'list' && item.kind === 'snippet' && C.hasFields(item.s.body, getSnippetBody)) {
        openForm(item);
        return;
      }
      finish(item, copy);
    }

    root.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (P.mode === 'form') {
        if (e.key === 'Escape') {
          e.preventDefault();
          P.form = null;
          if (formFor) return close();
          setMode('list');
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const idx = P.form.controls.indexOf(e.composedPath()[0]);
          if (e.metaKey || e.ctrlKey || idx === -1 || idx === P.form.controls.length - 1) choose(e.shiftKey);
          else P.form.controls[idx + 1].focus();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (P.items.length) setActive((P.active + 1) % P.items.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (P.items.length) setActive((P.active - 1 + P.items.length) % P.items.length);
          break;
        case 'Enter':
          e.preventDefault();
          choose(e.shiftKey);
          break;
        case 'Tab':
          e.preventDefault();
          setMode(P.mode === 'cleanup' ? 'list' : 'cleanup');
          break;
        case 'Escape':
          e.preventDefault();
          if (P.mode === 'cleanup') setMode('list');
          else close();
          break;
      }
    });

    input.addEventListener('input', () => {
      P.query = input.value;
      P.active = 0;
      renderList();
    });

    renderChips();
    if (formFor) {
      setMode('list');
      openForm({ kind: 'snippet', s: formFor });
    } else {
      setMode('list');
    }
  }

  // ------------------------------------------------------- trigger expansion

  function textBeforeCaret(el) {
    if (isTextControl(el)) {
      const r = selectionRange(el);
      if (!r || r[0] !== r[1]) return null;
      return el.value.slice(Math.max(0, r[0] - 80), r[0]);
    }
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    return range.startContainer.data.slice(0, range.startOffset).slice(-80);
  }

  function findTrigger(before, prefix) {
    let best = null;
    for (const s of state.snippets) {
      if (!s.trigger) continue;
      const token = prefix + s.trigger;
      if (!before.endsWith(token)) continue;
      const ch = before[before.length - token.length - 1];
      if (ch !== undefined && !/[\s([{"'>]/.test(ch)) continue;
      if (!best || s.trigger.length > best.trigger.length) best = s;
    }
    return best;
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.key !== ' ' && e.key !== 'Tab') || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (!state.settings.triggerExpansion || isOurs(e)) return;
      const elx = deepActiveElement();
      if (!isEditable(elx) || isSecretField(elx)) return;
      const before = textBeforeCaret(elx);
      if (!before) return;
      const prefix = state.settings.triggerPrefix || '';
      const snippet = findTrigger(before, prefix);
      if (!snippet) return;

      e.preventDefault();
      e.stopPropagation();
      const replaceLen = prefix.length + snippet.trigger.length;
      const target = captureTarget();
      if (C.hasFields(snippet.body, getSnippetBody)) {
        openPalette({ target, formFor: snippet, replaceLen });
        return;
      }
      const out = produce({ kind: 'snippet', s: snippet }, { clipboard: lazyClipboard(), selection: '' });
      send({ type: 'snippet:use', id: snippet.id, host });
      deliver(target, out, { replaceLen });
    },
    true
  );

  // ---------------------------------------------------------- paste clean

  async function pasteClean() {
    await ready;
    const target = captureTarget();
    const raw = readSystemClipboard() ?? state.history[0]?.text;
    if (!raw) {
      restoreTarget(target);
      toast('The clipboard is empty.');
      return;
    }
    const text = C.applyCleanup(raw, state.settings.defaultCleanup);
    if (target.el && insertAt(target, text, null)) return;
    restoreTarget(target);
    await copyText(text);
    toast(`Cleaned text copied. Press ${PASTE_KEY} to paste.`);
  }

  // ------------------------------------------------------------- messages

  // Commands are broadcast to every frame; only the focused one acts.
  function frameHasFocus() {
    if (!document.hasFocus()) return false;
    const a = document.activeElement;
    return !(a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME'));
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'get-selection') {
      sendResponse({ text: selectedText(deepActiveElement()) });
      return;
    }
    if (msg.type === 'get-location') {
      if (window === window.top) sendResponse({ host });
      return;
    }
    if (!msg.force && !frameHasFocus()) return;
    if (msg.type === 'open-palette') openPalette();
    else if (msg.type === 'paste-clean') pasteClean();
  });
})();
