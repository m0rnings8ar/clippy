// End-to-end test: loads the unpacked extension into Chrome and drives the
// playground page. Run with: npm run test:e2e
// CHROME_PATH overrides the browser; SHOTS=dir keeps screenshots there.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-shots-'));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const file = path.join(EXT, 'test', 'playground.html');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: CHROME,
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-profile-')),
  enableExtensions: [EXT],
  pipe: true,
  args: ['--no-first-run'],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));

  await sleep(500);
  let s = await storage();
  check('sample snippets seeded on install', (s.snippets || []).length === 5, `${(s.snippets || []).length} snippets`);

  await browser.defaultBrowserContext().overridePermissions(ORIGIN, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(ORIGIN + '/');
  await sleep(500);

  const copyText = async (selector) => {
    await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      const r = document.createRange();
      r.selectNodeContents(node);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }, selector);
    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyC', { commands: ['copy'] });
    await page.keyboard.up('Meta');
    await sleep(300);
  };
  const latest = async () => (await storage()).history?.[0]?.text || '';

  // --- copy capture
  await copyText('.copyable');
  check('copy event recorded to history', (await latest()).startsWith('Select and copy this sentence'));

  await copyText('.copyable:nth-of-type(3)');
  const h = (await storage()).history || [];
  check('sensitive copy (API key) skipped', !h.some((x) => x.text.includes('sk-ant-')), `${h.length} history items`);

  await page.click('#copy-btn');
  await sleep(300);
  check('navigator.clipboard.writeText() recorded via page hook', (await latest()).startsWith('Copied by a button'));

  await page.click('#setdata-btn');
  await sleep(300);
  check('clipboardData.setData() copy recorded', (await latest()) === '**Copied as markdown** via setData', await latest());

  // --- trigger expansion
  await page.click('#input');
  await page.keyboard.type(';date');
  await page.keyboard.press('Space');
  await sleep(200);
  const inputVal = await page.$eval('#input', (e) => e.value);
  check(';date expands in <input>', /^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+ \d{4}$/.test(inputVal), JSON.stringify(inputVal));

  await page.click('#textarea');
  await page.keyboard.type('Report: ;bug');
  await page.keyboard.press('Tab');
  await sleep(200);
  const ta = await page.$eval('#textarea', (e) => ({ v: e.value, c: e.selectionStart, n: +document.getElementById('count').textContent }));
  check(';bug expands in <textarea> after text', ta.v.startsWith('Report: **Steps to reproduce**\n1. \n'), JSON.stringify(ta.v.slice(0, 60)));
  check('{{cursor}} places the caret', ta.v.slice(0, ta.c).endsWith('1. '), `caret ${ta.c}`);
  check('{{url}} rendered', ta.v.includes(ORIGIN));
  check('input events fired for frameworks', ta.n > 0, `count ${ta.n}`);
  await page.keyboard.type('click save');
  const ta2 = await page.$eval('#textarea', (e) => e.value);
  check('typing continues at the caret', ta2.includes('1. click save\n'));

  // --- contenteditable + fill-in form
  await page.click('#editable');
  await page.keyboard.type(';fu');
  await page.keyboard.press('Space');
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'form.png') });
  await page.keyboard.type('Sam');
  await page.keyboard.press('Enter'); // -> select
  await page.keyboard.type('y'); // typeahead: today -> yesterday
  await page.keyboard.press('Enter'); // insert
  await sleep(300);
  const ce = await page.$eval('#editable', (e) => e.innerText);
  check('form-driven snippet inserted in contenteditable', ce.includes('Hi Sam,') && ce.includes('Thanks for your time yesterday.'), JSON.stringify(ce.slice(0, 80)));
  check('trigger text was replaced', !ce.includes(';fu'));

  // --- palette (commands can't be pressed from automation; send the same message)
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id);
  const send = (msg) => sw.evaluate((id, m) => chrome.tabs.sendMessage(id, m).catch(String), tabId, msg);

  await page.$eval('#input', (e) => (e.value = ''));
  await page.click('#input');
  await send({ type: 'open-palette', force: true });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, 'palette.png') });
  await page.keyboard.type('markdown link');
  await sleep(100);
  await page.keyboard.press('Enter');
  await sleep(300);
  const linkVal = await page.$eval('#input', (e) => e.value);
  check('palette search + Enter inserts snippet', linkVal === `[Clippy playground](${ORIGIN}/)`, JSON.stringify(linkVal));
  s = await storage();
  const linkSnip = s.snippets.find((x) => x.trigger === 'link');
  check('usage tracked per site', linkSnip.uses === 1 && linkSnip.siteUses['127.0.0.1'] === 1);

  // cleanup chain: Tab -> filter "upper" -> toggle -> Tab back -> insert ;date
  await page.$eval('#input', (e) => (e.value = ''));
  await page.click('#input');
  await send({ type: 'open-palette', force: true });
  await sleep(300);
  await page.keyboard.press('Tab');
  await page.keyboard.type('upper');
  await page.keyboard.press('Enter');
  await sleep(100);
  await page.screenshot({ path: path.join(SHOTS, 'cleanup.png') });
  await page.keyboard.press('Tab');
  await page.keyboard.type("today's date");
  await page.keyboard.press('Enter');
  await sleep(300);
  const upVal = await page.$eval('#input', (e) => e.value);
  check('cleanup chain applied on insert', upVal === upVal.toUpperCase() && /DAY, \d/.test(upVal), JSON.stringify(upVal));

  // history item from palette, with Esc restoring focus
  await page.$eval('#input', (e) => (e.value = ''));
  await page.click('#input');
  await send({ type: 'open-palette', force: true });
  await sleep(300);
  await page.keyboard.press('Escape');
  await sleep(100);
  const focused = await page.evaluate(() => document.activeElement.id);
  check('Esc closes palette and restores focus', focused === 'input', focused);

  await send({ type: 'open-palette', force: true });
  await sleep(300);
  await page.keyboard.type('select copy sentence');
  await page.keyboard.press('Enter');
  await sleep(300);
  const histVal = await page.$eval('#input', (e) => e.value);
  check('history item inserted from palette', histVal.startsWith('Select and copy this sentence'), JSON.stringify(histVal.slice(0, 40)));

  // paste clean: put a dirty string on the clipboard first
  await page.evaluate(() => navigator.clipboard.writeText('  https://example.com/a?id=1&utm_source=x​  '));
  await sleep(200);
  await page.$eval('#input', (e) => (e.value = ''));
  await page.click('#input');
  await send({ type: 'paste-clean', force: true });
  await sleep(400);
  const pc = await page.$eval('#input', (e) => e.value);
  check('paste-clean reads clipboard and strips tracking/invisible/whitespace', pc === 'https://example.com/a?id=1', JSON.stringify(pc));

  // --- popup
  const popup = await browser.newPage();
  await popup.setViewport({ width: 420, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await sleep(500);
  const rows = await popup.$$eval('#snippet-list li', (l) => l.length);
  check('popup lists snippets', rows === 5, `${rows}`);
  await popup.screenshot({ path: path.join(SHOTS, 'popup-snippets.png') });

  await popup.click('#new-snippet');
  await popup.type('input[name=name]', 'Greeting');
  await popup.type('input[name=trigger]', 'hi');
  await popup.type('textarea[name=body]', 'Hello {{input:Who|team}}!{{cursor}}');
  await sleep(100);
  const prev = await popup.$eval('#editor-preview', (e) => e.textContent);
  check('editor live preview renders defaults', prev === 'Hello team!▍', JSON.stringify(prev));
  await popup.screenshot({ path: path.join(SHOTS, 'popup-editor.png') });
  await popup.click('button[type=submit]');
  await sleep(300);
  s = await storage();
  check('snippet saved from popup', s.snippets.some((x) => x.trigger === 'hi' && x.name === 'Greeting'));

  await popup.click('#new-snippet');
  await popup.type('input[name=name]', 'Dup');
  await popup.type('input[name=trigger]', 'hi');
  await popup.click('button[type=submit]');
  await sleep(300);
  const err = await popup.$eval('#editor-error', (e) => e.textContent);
  check('duplicate trigger rejected', err.includes('already used'), err);
  await popup.click('#cancel-edit');

  await popup.click('nav button[data-tab=history]');
  await sleep(200);
  const hrows = await popup.$$eval('#history-list li', (l) => l.length);
  check('popup lists history', hrows >= 4, `${hrows}`);
  await popup.screenshot({ path: path.join(SHOTS, 'popup-history.png') });

  await popup.click('nav button[data-tab=settings]');
  await sleep(200);
  await popup.click('input[name=recording]');
  await sleep(300);
  s = await storage();
  check('settings toggle persists', s.settings.recording === false);
  await popup.screenshot({ path: path.join(SHOTS, 'popup-settings.png'), fullPage: true });

  await page.bringToFront();
  const before = (await storage()).history.length;
  await copyText('#copy-btn');
  check('paused recording ignores copies', (await storage()).history.length === before);
} catch (e) {
  console.error('ERROR', e);
  results.push({ name: 'script', ok: false });
} finally {
  await browser.close();
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed  (screenshots: ${SHOTS})`);
  process.exit(failed ? 1 : 0);
}
