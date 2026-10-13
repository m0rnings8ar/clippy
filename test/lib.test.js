// Run with: node --test test/
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../lib/search.js');
require('../lib/templates.js');
require('../lib/cleanup.js');
require('../lib/sensitive.js');
const C = globalThis.Clippy;

// --- templates ---

const NOW = new Date(2026, 9, 13, 14, 5, 9); // Tue 13 Oct 2026 14:05:09

test('date and time defaults and formats', () => {
  assert.equal(C.render('{{date}}', { now: NOW }).text, '2026-10-13');
  assert.equal(C.render('{{time}}', { now: NOW }).text, '14:05');
  assert.equal(C.render('{{date:dddd, D MMMM YYYY}}', { now: NOW }).text, 'Tuesday, 13 October 2026');
  assert.equal(C.render('{{time:h:mm A}}', { now: NOW }).text, '2:05 PM');
  assert.equal(C.render('{{date:[Week of] MMM D}}', { now: NOW }).text, 'Week of Oct 13');
});

test('context variables', () => {
  const ctx = { clipboard: 'CLIP', selection: 'SEL', url: 'https://x.dev/a', title: 'T', host: 'x.dev' };
  assert.equal(C.render('{{clipboard}}|{{selection}}|{{url}}|{{title}}|{{host}}', ctx).text, 'CLIP|SEL|https://x.dev/a|T|x.dev');
});

test('input and select use values, then defaults', () => {
  const body = 'Hi {{input:Name|there}}, {{select:Tone|warm|formal}} {{input:Name}}';
  assert.equal(C.render(body).text, 'Hi there, warm there');
  assert.equal(C.render(body, { values: { Name: 'Sam', Tone: 'formal' } }).text, 'Hi Sam, formal Sam');
});

test('cursor offset is reported and removed', () => {
  const r = C.render('Hello {{cursor}}world');
  assert.equal(r.text, 'Hello world');
  assert.equal(r.cursorOffset, 6);
  assert.equal(C.render('no cursor').cursorOffset, null);
});

test('escapes and unknown variables stay literal', () => {
  assert.equal(C.render('\\{{date}}').text, '{{date}}');
  assert.equal(C.render('{{nope}} {{ date }}', { now: NOW }).text, '{{nope}} 2026-10-13');
});

test('nested snippets render and stop at max depth', () => {
  const lib = { sig: 'Best, {{input:Name|Sam}}', loop: 'x{{snippet:loop}}' };
  const getSnippet = (t) => lib[t];
  assert.equal(C.render('Thanks!\n{{snippet:sig}}', { getSnippet }).text, 'Thanks!\nBest, Sam');
  assert.equal(C.render('{{snippet:missing}}', { getSnippet }).text, '{{snippet:missing}}');
  assert.match(C.render('{{snippet:loop}}', { getSnippet }).text, /^xxx+\{\{snippet:loop\}\}$/);
});

test('extractFields finds unique fields, including nested ones', () => {
  const lib = { sig: '{{input:Name}} {{input:Role|Engineer}}' };
  const fields = C.extractFields('{{input:Name}} {{select:Tone|warm|formal}} {{snippet:sig}}', (t) => lib[t]);
  assert.deepEqual(fields, [
    { kind: 'input', label: 'Name', default: '' },
    { kind: 'select', label: 'Tone', options: ['warm', 'formal'], default: 'warm' },
    { kind: 'input', label: 'Role', default: 'Engineer' },
  ]);
  assert.equal(C.hasFields('{{date}}'), false);
});

// --- cleanup ---

test('strip tracking params keeps real params and trailing punctuation', () => {
  const t = 'See https://ex.com/p?id=4&utm_source=x&fbclid=abc. And https://ex.com/?utm_medium=y)';
  assert.equal(C.applyCleanup(t, ['stripTracking']), 'See https://ex.com/p?id=4. And https://ex.com/)');
  assert.equal(C.applyCleanup('https://ex.com/a', ['stripTracking']), 'https://ex.com/a');
});

test('unwrap lines joins paragraphs but keeps lists and blank lines', () => {
  const t = 'This is a hard\nwrapped para-\ngraph.\n\n- one\n- two';
  assert.equal(C.applyCleanup(t, ['unwrapLines']), 'This is a hard wrapped paragraph.\n\n- one\n- two');
});

test('punctuation, invisible chars, case, slug, json', () => {
  assert.equal(C.applyCleanup('“Hi” — it’s…', ['plainPunctuation']), '"Hi" - it\'s...');
  assert.equal(C.applyCleanup('a​b﻿', ['stripInvisible']), 'ab');
  assert.equal(C.applyCleanup('hello big world', ['titleCase']), 'Hello Big World');
  assert.equal(C.applyCleanup('HELLO. WORLD here', ['sentenceCase']), 'Hello. World here');
  assert.equal(C.applyCleanup('  Héllo, World!  ', ['slugify']), 'hello-world');
  assert.equal(C.applyCleanup('{"a":1}', ['prettyJson']), '{\n  "a": 1\n}');
  assert.equal(C.applyCleanup('not json', ['prettyJson']), 'not json');
});

test('cleanup chains apply in order and ignore unknown ids', () => {
  assert.equal(C.applyCleanup('  a\n\n\n\nb  \t ', ['collapseWhitespace', 'trim', 'bogus']), 'a\n\nb');
  assert.equal(C.applyCleanup('a\n\n b', ['removeBlankLines']), 'a\n b');
});

// --- search ---

test('rank prefers name/trigger matches and substring over subsequence', () => {
  const snippets = [
    { name: 'Bug report', trigger: 'bug', body: 'Steps…', tags: ['github'] },
    { name: 'Follow-up', trigger: 'fu', body: 'Thanks for the bug fix', tags: [] },
    { name: 'Brief update', trigger: 'bu', body: '', tags: [] },
  ];
  const r = C.rank('bug', snippets, C.snippetFields).map((s) => s.trigger);
  assert.deepEqual(r, ['bug', 'fu']);
  assert.deepEqual(C.rank('bu', snippets, C.snippetFields)[0].trigger, 'bu');
  assert.deepEqual(C.rank('git bug', snippets, C.snippetFields).map((s) => s.trigger), ['bug']);
  assert.equal(C.rank('', snippets, C.snippetFields).length, 3);
});

test('host matching', () => {
  assert.ok(C.hostMatches('github.com', 'github.com'));
  assert.ok(C.hostMatches('gist.github.com', 'github.com'));
  assert.ok(!C.hostMatches('notgithub.com', 'github.com'));
  assert.ok(C.hostMatches('acme.atlassian.net', '*.atlassian.net'));
  assert.ok(C.hostMatches('mail.google.com', 'https://mail.google.com/mail'));
});

test('suggest ranks site rules, then local usage', () => {
  const snippets = [
    { id: 'a', sites: [], uses: 50, siteUses: {} },
    { id: 'b', sites: ['github.com'], uses: 0 },
    { id: 'c', sites: [], uses: 2, siteUses: { 'github.com': 3 } },
  ];
  assert.deepEqual(C.suggest(snippets, 'github.com').map((s) => s.id), ['b', 'c']);
  assert.deepEqual(C.suggest(snippets, 'example.com').map((s) => s.id), []);
});

// --- sensitive ---

test('detects secrets', () => {
  assert.equal(C.detectSensitive('key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'), 'API key');
  assert.equal(C.detectSensitive('AKIAIOSFODNN7EXAMPLE'), 'AWS access key');
  assert.equal(C.detectSensitive('ghp_' + 'a1B2'.repeat(9)), 'GitHub token');
  assert.equal(C.detectSensitive('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'), 'private key');
  assert.equal(C.detectSensitive('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU'), 'JWT');
  assert.equal(C.detectSensitive('card 4111 1111 1111 1111 exp'), 'card number');
  assert.equal(C.detectSensitive('Xq7pL2mN9vR4tK8wZ3bH6jF1'), 'secret-looking token');
});

test('ignores ordinary text', () => {
  for (const t of [
    'Hello world, call me at +91 98765 43210',
    'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', // git sha
    '123e4567-e89b-12d3-a456-426614174000', // uuid
    'https://example.com/path?q=SomeThing123',
    'Order 1234567890123 shipped', // fails Luhn
    'CamelCaseIdentifierName',
  ]) {
    assert.equal(C.detectSensitive(t), null, t);
  }
});
