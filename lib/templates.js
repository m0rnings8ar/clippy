// Snippet template engine: {{name}} / {{name:arg}} variables.
(function (root) {
  const Clippy = (root.Clippy = root.Clippy || {});

  // \{{ is a literal "{{". Otherwise {{ name[:arg] }} where arg may contain
  // anything except "}}".
  const TOKEN = /\\\{\{|\{\{\s*([a-zA-Z]+)(?::((?:(?!\}\}).)*?))?\s*\}\}/g;
  const MAX_DEPTH = 3;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  // Moment-style tokens; [text] is emitted literally.
  function formatDate(d, fmt) {
    return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A/g, (tok, literal) => {
      if (literal !== undefined) return literal;
      const h12 = d.getHours() % 12 || 12;
      switch (tok) {
        case 'YYYY': return String(d.getFullYear());
        case 'YY': return pad(d.getFullYear() % 100);
        case 'MMMM': return MONTHS[d.getMonth()];
        case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
        case 'MM': return pad(d.getMonth() + 1);
        case 'M': return String(d.getMonth() + 1);
        case 'DD': return pad(d.getDate());
        case 'D': return String(d.getDate());
        case 'dddd': return DAYS[d.getDay()];
        case 'ddd': return DAYS[d.getDay()].slice(0, 3);
        case 'HH': return pad(d.getHours());
        case 'H': return String(d.getHours());
        case 'hh': return pad(h12);
        case 'h': return String(h12);
        case 'mm': return pad(d.getMinutes());
        case 'ss': return pad(d.getSeconds());
        case 'A': return d.getHours() < 12 ? 'AM' : 'PM';
      }
      return tok;
    });
  }

  // "Name|default" -> { label, def }
  function splitArg(arg) {
    const parts = (arg || '').split('|').map((p) => p.trim());
    return { label: parts[0] || 'Value', rest: parts.slice(1) };
  }

  // Fill-in fields a snippet needs before it can be rendered, in order of
  // first appearance (including nested {{snippet:x}} bodies).
  function extractFields(body, getSnippet, depth = 0, seen = new Map()) {
    if (!body || depth > MAX_DEPTH) return [...seen.values()];
    for (const m of body.matchAll(TOKEN)) {
      const name = (m[1] || '').toLowerCase();
      if (name === 'input' || name === 'select') {
        const { label, rest } = splitArg(m[2]);
        if (seen.has(label)) continue;
        if (name === 'input') seen.set(label, { kind: 'input', label, default: rest[0] || '' });
        else seen.set(label, { kind: 'select', label, options: rest.length ? rest : [''], default: rest[0] || '' });
      } else if (name === 'snippet' && getSnippet) {
        extractFields(getSnippet((m[2] || '').trim()), getSnippet, depth + 1, seen);
      }
    }
    return [...seen.values()];
  }

  function hasFields(body, getSnippet) {
    return extractFields(body, getSnippet).length > 0;
  }

  // ctx: { now, clipboard, selection, url, title, host, values, getSnippet }
  // Returns { text, cursorOffset } where cursorOffset is the index of the
  // first {{cursor}} or null.
  function render(body, ctx = {}, depth = 0) {
    const now = ctx.now || new Date();
    const values = ctx.values || {};
    // A field's default may be given on any occurrence, e.g. the first one.
    const defaults =
      ctx.defaults ||
      Object.fromEntries(extractFields(body, ctx.getSnippet).map((f) => [f.label, f.default]));
    let out = '';
    let cursorOffset = null;
    let last = 0;
    for (const m of (body || '').matchAll(TOKEN)) {
      out += body.slice(last, m.index);
      last = m.index + m[0].length;
      if (m[0] === '\\{{') {
        out += '{{';
        continue;
      }
      const name = m[1].toLowerCase();
      const arg = m[2] === undefined ? '' : m[2].trim();
      let value;
      switch (name) {
        case 'date': value = formatDate(now, arg || 'YYYY-MM-DD'); break;
        case 'time': value = formatDate(now, arg || 'HH:mm'); break;
        case 'clipboard': value = ctx.clipboard || ''; break;
        case 'selection': value = ctx.selection || ''; break;
        case 'url': value = ctx.url || ''; break;
        case 'title': value = ctx.title || ''; break;
        case 'host': value = ctx.host || ''; break;
        case 'input':
        case 'select': {
          const { label, rest } = splitArg(arg);
          value = Object.prototype.hasOwnProperty.call(values, label) ? values[label] : rest[0] || defaults[label] || '';
          break;
        }
        case 'cursor':
          if (depth === 0 && cursorOffset === null) cursorOffset = out.length;
          value = '';
          break;
        case 'snippet': {
          const nested = ctx.getSnippet && ctx.getSnippet(arg);
          value = nested != null && depth < MAX_DEPTH ? render(nested, { ...ctx, now, defaults }, depth + 1).text : m[0];
          break;
        }
        default:
          value = m[0]; // unknown variable: leave it visible
      }
      out += value;
    }
    out += (body || '').slice(last);
    return { text: out, cursorOffset };
  }

  const VARIABLES = [
    { insert: '{{date}}', help: 'Today, e.g. 2026-10-13. Format: {{date:D MMM YYYY}}' },
    { insert: '{{time}}', help: 'Current time, e.g. 14:05. Format: {{time:h:mm A}}' },
    { insert: '{{clipboard}}', help: 'Current clipboard text' },
    { insert: '{{selection}}', help: 'Text selected on the page' },
    { insert: '{{url}}', help: 'Page URL' },
    { insert: '{{title}}', help: 'Page title' },
    { insert: '{{input:Name}}', help: 'Ask for a value. Default: {{input:Name|Sam}}' },
    { insert: '{{select:Tone|warm|formal}}', help: 'Pick from options' },
    { insert: '{{cursor}}', help: 'Where the caret lands after inserting' },
    { insert: '{{snippet:trigger}}', help: 'Include another snippet' },
  ];

  Object.assign(Clippy, { formatDate, extractFields, hasFields, render, VARIABLES });
  if (typeof module !== 'undefined' && module.exports) module.exports = Clippy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
