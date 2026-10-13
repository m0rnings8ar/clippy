// Toolbar popup: snippet library, clipboard history and settings. Reads
// chrome.storage.local directly; every change goes through background.js.
const C = globalThis.Clippy;
const $ = (sel) => document.querySelector(sel);

const state = { snippets: [], history: [], settings: C.withDefaults() };
const ui = { tab: 'snippets', tagFilter: null, editing: null, activeHost: '' };

// Opened as a normal tab when chrome.action.openPopup() isn't available.
if (new URLSearchParams(location.search).has('full')) document.body.classList.add('tab');

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: String(err) }));
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const firstLine = (t) => (t.split('\n').find((l) => l.trim()) || '').trim();

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function copy(text, button) {
  await navigator.clipboard.writeText(text);
  if (button) {
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = old), 1000);
  }
}

// ------------------------------------------------------------------ tabs

function showPanel(id) {
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.id !== id;
}

function selectTab(tab) {
  ui.tab = tab;
  ui.editing = null;
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  showPanel(tab);
  render();
  const focus = { snippets: '#snippet-search', history: '#history-search' }[tab];
  if (focus) $(focus).focus();
}

for (const b of document.querySelectorAll('nav button')) b.addEventListener('click', () => selectTab(b.dataset.tab));

// --------------------------------------------------------------- snippets

function renderSnippets() {
  const tags = [...new Set(state.snippets.flatMap((s) => s.tags || []))].sort();
  if (ui.tagFilter && !tags.includes(ui.tagFilter)) ui.tagFilter = null;
  $('#tag-filter').replaceChildren(
    ...tags.map((t) =>
      el('button', { class: 'tag', 'aria-pressed': String(t === ui.tagFilter), onclick: () => ((ui.tagFilter = ui.tagFilter === t ? null : t), renderSnippets()) }, t)
    )
  );

  let items = state.snippets.filter((s) => !ui.tagFilter || (s.tags || []).includes(ui.tagFilter));
  const q = $('#snippet-search').value;
  items = q ? C.rank(q, items, C.snippetFields) : items.sort((a, b) => a.name.localeCompare(b.name));

  const prefix = state.settings.triggerPrefix;
  $('#snippet-list').replaceChildren(
    ...items.map((s) =>
      el(
        'li',
        { tabindex: '0', onclick: () => openEditor(s), onkeydown: (e) => e.key === 'Enter' && openEditor(s) },
        el('div', { class: 'title' }, el('span', { class: 'name' }, s.name), s.trigger ? el('span', { class: 'badge' }, prefix + s.trigger) : null),
        el('div', { class: 'meta' }, firstLine(s.body) || '(empty)'),
        (s.tags?.length || s.sites?.length || s.uses)
          ? el('div', { class: 'meta' }, [s.tags?.join(', '), s.sites?.length ? `on ${s.sites.join(', ')}` : '', s.uses ? `used ${s.uses}×` : ''].filter(Boolean).join(' · '))
          : null
      )
    )
  );
  if (!items.length) {
    $('#snippet-list').append(el('li', { class: 'empty' }, state.snippets.length ? 'No snippets match.' : 'No snippets yet. Click New to add one.'));
  }
}

$('#snippet-search').addEventListener('input', renderSnippets);
$('#new-snippet').addEventListener('click', () => openEditor(null));

// ----------------------------------------------------------------- editor

const form = $('#editor-form');

for (const v of C.VARIABLES) $('#insert-var').append(el('option', { value: v.insert }, v.insert));
$('#insert-var').addEventListener('change', (e) => {
  const value = e.target.value;
  if (!value) return;
  const ta = form.elements.body;
  ta.focus();
  ta.setRangeText(value, ta.selectionStart, ta.selectionEnd, 'end');
  $('#var-help').textContent = C.VARIABLES.find((v) => v.insert === value)?.help || '';
  e.target.value = '';
  updateEditorPreview();
});

function updateEditorPreview() {
  const body = form.elements.body.value;
  const { text, cursorOffset } = C.render(body, {
    clipboard: state.history[0]?.text || 'clipboard text',
    selection: 'selected text',
    url: 'https://example.com/page',
    title: 'Example page',
    host: 'example.com',
    getSnippet: (t) => state.snippets.find((s) => s.trigger === t)?.body,
  });
  const pre = $('#editor-preview');
  if (cursorOffset == null) pre.replaceChildren(text || ' ');
  else pre.replaceChildren(text.slice(0, cursorOffset), el('span', { class: 'caret' }, '▍'), text.slice(cursorOffset));
}
form.elements.body.addEventListener('input', updateEditorPreview);

function openEditor(snippet, draft = {}) {
  ui.editing = snippet;
  const s = snippet || { name: '', trigger: '', tags: [], sites: [], body: '', ...draft };
  form.elements.name.value = s.name;
  form.elements.trigger.value = s.trigger || '';
  form.elements.tags.value = (s.tags || []).join(', ');
  form.elements.sites.value = (s.sites || []).join(', ');
  form.elements.body.value = s.body;
  $('#prefix-hint').textContent = state.settings.triggerPrefix;
  $('#delete-snippet').hidden = !snippet;
  $('#editor-error').textContent = '';
  $('#add-site').hidden = !ui.activeHost;
  $('#add-site').textContent = `+ ${ui.activeHost}`;
  updateEditorPreview();
  showPanel('editor');
  (snippet ? form.elements.body : form.elements.name).focus();
}

function closeEditor() {
  selectTab('snippets');
}

$('#add-site').addEventListener('click', () => {
  const sites = form.elements.sites.value.split(',').map((x) => x.trim()).filter(Boolean);
  if (!sites.includes(ui.activeHost)) sites.push(ui.activeHost);
  form.elements.sites.value = sites.join(', ');
});

$('#cancel-edit').addEventListener('click', closeEditor);

$('#delete-snippet').addEventListener('click', async () => {
  if (!ui.editing || !confirm(`Delete "${ui.editing.name}"?`)) return;
  await send({ type: 'snippet:delete', id: ui.editing.id });
  closeEditor();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const trigger = f.trigger.value.trim();
  if (/\s/.test(trigger)) {
    $('#editor-error').textContent = 'Triggers cannot contain spaces.';
    return;
  }
  const res = await send({
    type: 'snippet:save',
    snippet: { id: ui.editing?.id, name: f.name.value, trigger, tags: f.tags.value, sites: f.sites.value, body: f.body.value },
  });
  if (!res?.ok) {
    $('#editor-error').textContent = res?.error || 'Could not save.';
    return;
  }
  closeEditor();
});

form.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  if (e.key === 'Escape') {
    e.preventDefault();
    closeEditor();
  }
});

// ---------------------------------------------------------------- history

function renderHistory() {
  const q = $('#history-search').value;
  const items = q ? C.rank(q, state.history, C.historyFields) : state.history;
  $('#history-list').replaceChildren(
    ...items.map((h) =>
      el(
        'li',
        { class: h.pinned ? 'pinned' : '', tabindex: '0', title: 'Click to copy', onclick: (e) => copy(h.text, e.currentTarget.querySelector('.copy-btn')) },
        el('div', { class: 'clip' }, h.text.length > 600 ? h.text.slice(0, 600) + '…' : h.text),
        el('div', { class: 'meta' }, [h.pinned ? 'Pinned' : '', hostOf(h.sourceUrl), ago(h.at), `${h.text.length} chars`].filter(Boolean).join(' · ')),
        el(
          'div',
          { class: 'item-actions', onclick: (e) => e.stopPropagation() },
          el('button', { class: 'copy-btn', onclick: (e) => copy(h.text, e.currentTarget) }, 'Copy'),
          el('button', { onclick: () => send({ type: 'history:pin', id: h.id, pinned: !h.pinned }) }, h.pinned ? 'Unpin' : 'Pin'),
          el('button', { onclick: () => openEditor(null, { name: firstLine(h.text).slice(0, 40), body: h.text, sites: [] }) }, 'Make snippet'),
          el('button', { class: 'danger', onclick: () => send({ type: 'history:delete', id: h.id }) }, 'Delete')
        )
      )
    )
  );
  if (!items.length) {
    $('#history-list').append(
      el('li', { class: 'empty' }, state.history.length ? 'Nothing matches.' : 'Copied text from web pages will show up here.')
    );
  }
  const rec = state.settings.recording;
  const btn = $('#toggle-recording');
  btn.className = `pill ${rec ? 'on' : 'off'}`;
  btn.textContent = rec ? 'Recording' : 'Paused';
  btn.title = rec ? 'Click to pause recording' : 'Click to resume recording';
  const pinned = state.history.filter((h) => h.pinned).length;
  $('#history-count').textContent = `${state.history.length} items${pinned ? `, ${pinned} pinned` : ''}`;
}

$('#history-search').addEventListener('input', renderHistory);
$('#toggle-recording').addEventListener('click', () => send({ type: 'settings:save', settings: { recording: !state.settings.recording } }));
$('#clear-history').addEventListener('click', () => {
  if (confirm('Clear clipboard history? Pinned items are kept.')) send({ type: 'history:clear' });
});

// --------------------------------------------------------------- settings

const sform = $('#settings-form');

for (const [id, t] of Object.entries(C.TRANSFORMS)) {
  $('#cleanup-options').append(el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'cleanup', value: id }), t.label));
}

function renderSettings() {
  const s = state.settings;
  const f = sform.elements;
  for (const k of ['recording', 'skipSensitive', 'triggerExpansion']) f[k].checked = !!s[k];
  // Don't clobber a field the user is typing in.
  if (document.activeElement !== f.historyLimit) f.historyLimit.value = s.historyLimit;
  if (document.activeElement !== f.triggerPrefix) f.triggerPrefix.value = s.triggerPrefix;
  if (document.activeElement !== f.excludedHosts) f.excludedHosts.value = s.excludedHosts.join('\n');
  for (const box of sform.querySelectorAll('input[name=cleanup]')) box.checked = s.defaultCleanup.includes(box.value);
}

function readSettings() {
  const f = sform.elements;
  const prevChain = state.settings.defaultCleanup;
  const checked = [...sform.querySelectorAll('input[name=cleanup]:checked')].map((b) => b.value);
  // Keep the existing order for transforms that stay on; append new ones.
  const chain = [...prevChain.filter((id) => checked.includes(id)), ...checked.filter((id) => !prevChain.includes(id))];
  return {
    recording: f.recording.checked,
    skipSensitive: f.skipSensitive.checked,
    triggerExpansion: f.triggerExpansion.checked,
    historyLimit: Math.max(10, Math.min(2000, parseInt(f.historyLimit.value, 10) || 200)),
    triggerPrefix: f.triggerPrefix.value.trim(),
    excludedHosts: f.excludedHosts.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
    defaultCleanup: chain,
  };
}

let settingsTimer = 0;
sform.addEventListener('change', () => send({ type: 'settings:save', settings: readSettings() }));
sform.addEventListener('input', (e) => {
  if (e.target.type === 'checkbox') return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => send({ type: 'settings:save', settings: readSettings() }), 400);
});

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const names = { 'open-palette': 'Open palette', 'paste-clean': 'Paste clean', _execute_action: 'Open this popup' };
  $('#shortcut-list').replaceChildren(
    ...commands.map((c) => el('li', {}, c.shortcut ? el('kbd', {}, c.shortcut) : el('span', { class: 'muted' }, 'not set'), ' ', names[c.name] || c.description))
  );
}
$('#edit-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

$('#export').addEventListener('click', () => {
  const data = { app: 'clippy', version: 1, exportedAt: new Date().toISOString(), snippets: state.snippets };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: `clippy-snippets-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('#backup-status').textContent = `Exported ${state.snippets.length} snippets.`;
});

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const res = await send({ type: 'data:import', data: Array.isArray(data) ? { snippets: data } : data });
    $('#backup-status').textContent = res?.ok ? `Imported ${res.added} snippets.` : `Import failed: ${res?.error || 'unknown error'}`;
  } catch (err) {
    $('#backup-status').textContent = `Import failed: ${err.message}`;
  }
});

// ------------------------------------------------------------------ boot

function render() {
  if (ui.tab === 'snippets' && !ui.editing && $('#editor').hidden) renderSnippets();
  if (ui.tab === 'history') renderHistory();
  if (ui.tab === 'settings') renderSettings();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.snippets) state.snippets = changes.snippets.newValue || [];
  if (changes.history) state.history = changes.history.newValue || [];
  if (changes.settings) state.settings = C.withDefaults(changes.settings.newValue);
  render();
});

(async () => {
  const s = await chrome.storage.local.get(['snippets', 'history', 'settings']);
  state.snippets = s.snippets || [];
  state.history = s.history || [];
  state.settings = C.withDefaults(s.settings);
  renderShortcuts();

  // Host of the active tab, for the "+ this site" button.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = tab?.id && (await chrome.tabs.sendMessage(tab.id, { type: 'get-location' }, { frameId: 0 }).catch(() => null));
    ui.activeHost = res?.host || '';
  } catch {}

  // A draft from the "Save selection as snippet" context menu.
  const { draft } = await chrome.storage.session.get('draft');
  if (draft) {
    await chrome.storage.session.remove('draft');
    selectTab('snippets');
    openEditor(null, { name: firstLine(draft.body).slice(0, 40), body: draft.body, sites: draft.sites || [] });
    return;
  }
  selectTab(new URLSearchParams(location.search).get('tab') || 'snippets');
})();
