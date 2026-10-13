// Text cleanup transforms, chainable in any order.
(function (root) {
  const Clippy = (root.Clippy = root.Clippy || {});

  const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|gclsrc|dclid|msclkid|mc_eid|mc_cid|igshid|yclid|_hsenc|_hsmi|mkt_tok|ref_src|si|spm|vero_id|oly_[a-z_]+|wickedid|trk|trkCampaign)$/i;

  function stripTrackingFromUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return raw;
    }
    const before = url.search;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    if (url.search === before) return raw;
    let out = url.toString();
    if (!url.search) out = out.replace('?', '');
    return out;
  }

  const LIST_ITEM = /^\s*([-*•+]|\d+[.)])\s/;

  const TRANSFORMS = {
    trim: {
      label: 'Trim',
      fn: (t) => t.replace(/[ \t]+$/gm, '').trim(),
    },
    collapseWhitespace: {
      label: 'Collapse spaces',
      fn: (t) => t.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n'),
    },
    unwrapLines: {
      label: 'Unwrap lines',
      // Joins hard-wrapped lines within a paragraph; keeps blank lines and list items.
      fn: (t) =>
        t
          .split(/\n{2,}/)
          .map((para) =>
            para.split('\n').reduce((acc, line) => {
              if (!acc) return line;
              if (LIST_ITEM.test(line)) return acc + '\n' + line;
              // "hyphen-\nated" -> "hyphenated"
              if (/\w-$/.test(acc)) return acc.slice(0, -1) + line.trimStart();
              return acc.replace(/\s+$/, '') + ' ' + line.trimStart();
            }, '')
          )
          .join('\n\n'),
    },
    plainPunctuation: {
      label: 'Plain quotes',
      fn: (t) =>
        t
          .replace(/[‘’‚‛′]/g, "'")
          .replace(/[“”„‟″]/g, '"')
          .replace(/[–—]/g, '-')
          .replace(/…/g, '...')
          .replace(/ /g, ' '),
    },
    stripTracking: {
      label: 'Strip tracking',
      fn: (t) =>
        t.replace(/https?:\/\/[^\s<>"'`]+/g, (match) => {
          // Trailing punctuation usually belongs to the sentence, not the URL.
          const m = match.match(/^(.*?)([.,;:!?)\]]*)$/);
          return stripTrackingFromUrl(m[1]) + m[2];
        }),
    },
    stripInvisible: {
      label: 'Strip invisible',
      fn: (t) => t.replace(/[​-‍⁠﻿­]/g, ''),
    },
    removeBlankLines: {
      label: 'Remove blank lines',
      fn: (t) => t.split('\n').filter((l) => l.trim()).join('\n'),
    },
    lowercase: { label: 'lowercase', fn: (t) => t.toLowerCase() },
    uppercase: { label: 'UPPERCASE', fn: (t) => t.toUpperCase() },
    titleCase: {
      label: 'Title Case',
      fn: (t) => t.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase()),
    },
    sentenceCase: {
      label: 'Sentence case',
      fn: (t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase()),
    },
    slugify: {
      label: 'slugify',
      fn: (t) =>
        t
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, ''),
    },
    prettyJson: {
      label: 'Pretty JSON',
      fn: (t) => {
        try {
          return JSON.stringify(JSON.parse(t), null, 2);
        } catch {
          return t;
        }
      },
    },
  };

  const DEFAULT_CLEANUP = ['stripInvisible', 'stripTracking', 'trim'];

  function applyCleanup(text, ids) {
    return (ids || []).reduce((acc, id) => (TRANSFORMS[id] ? TRANSFORMS[id].fn(acc) : acc), text);
  }

  Object.assign(Clippy, { TRANSFORMS, DEFAULT_CLEANUP, applyCleanup, stripTrackingFromUrl });
  if (typeof module !== 'undefined' && module.exports) module.exports = Clippy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
