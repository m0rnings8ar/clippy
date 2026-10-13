// Fuzzy ranking and host matching shared by the palette and the popup.
(function (root) {
  const Clippy = (root.Clippy = root.Clippy || {});

  const BOUNDARY = /[\s\-_./:,;()[\]{}'"`]/;

  // Score one query term against one string. 0 = no match.
  function scoreTerm(term, text) {
    if (!text) return 0;
    const t = text.toLowerCase();
    const idx = t.indexOf(term);
    if (idx !== -1) {
      const atBoundary = idx === 0 || BOUNDARY.test(t[idx - 1]);
      const exact = t === term ? 100 : 0;
      return 100 + exact + term.length * 10 + (atBoundary ? 50 : 0) - Math.min(idx, 40);
    }
    // Subsequence match: every char in order, rewarding runs and word starts.
    let from = 0;
    let prev = -2;
    let score = 0;
    for (const ch of term) {
      const found = t.indexOf(ch, from);
      if (found === -1) return 0;
      score += 1;
      if (found === prev + 1) score += 4;
      if (found === 0 || BOUNDARY.test(t[found - 1])) score += 6;
      prev = found;
      from = found + 1;
    }
    // Long scattered matches are weak; keep them below any substring hit.
    return Math.min(score, 99) - Math.min(t.length / 200, 5);
  }

  // fields: array of [text, weight]. Every whitespace-separated term must
  // match at least one field.
  function scoreFields(query, fields) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return 1;
    let total = 0;
    for (const term of terms) {
      let best = 0;
      for (const [text, weight] of fields) {
        const s = scoreTerm(term, text) * (weight || 1);
        if (s > best) best = s;
      }
      if (best <= 0) return 0;
      total += best;
    }
    return total;
  }

  // Returns items that match, best first. Ties keep the original order.
  function rank(query, items, getFields) {
    if (!query || !query.trim()) return items.slice();
    return items
      .map((item, i) => ({ item, i, s: scoreFields(query, getFields(item)) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((r) => r.item);
  }

  function snippetFields(s) {
    return [
      [s.name, 3],
      [s.trigger, 3],
      [(s.tags || []).join(' '), 2],
      [s.body, 1],
    ];
  }

  function historyFields(h) {
    return [[h.text, 1]];
  }

  // "example.com" matches the host and its subdomains; "*" is a wildcard.
  function hostMatches(host, pattern) {
    if (!host || !pattern) return false;
    host = host.toLowerCase();
    let p = pattern.trim().toLowerCase();
    p = p.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
    if (!p) return false;
    if (p.includes('*')) {
      const re = new RegExp(
        '^' + p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
      );
      return re.test(host);
    }
    return host === p || host.endsWith('.' + p);
  }

  function hostMatchesAny(host, patterns) {
    return (patterns || []).some((p) => hostMatches(host, p));
  }

  // Snippets worth showing first on this host: explicit site rules, then
  // snippets used here before, then globally popular ones.
  function suggest(snippets, host, limit = 5) {
    return snippets
      .map((s) => {
        const siteRule = hostMatchesAny(host, s.sites) ? 1000 : 0;
        const localUses = ((s.siteUses || {})[host] || 0) * 10;
        const uses = Math.min(s.uses || 0, 9);
        return { s, score: siteRule + localUses + uses };
      })
      .filter((r) => r.score >= 10)
      .sort((a, b) => b.score - a.score || (b.s.updatedAt || 0) - (a.s.updatedAt || 0))
      .slice(0, limit)
      .map((r) => r.s);
  }

  Object.assign(Clippy, { scoreFields, rank, snippetFields, historyFields, hostMatches, hostMatchesAny, suggest });
  if (typeof module !== 'undefined' && module.exports) module.exports = Clippy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
