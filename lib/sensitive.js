// Heuristics for copies that should never be written to history.
(function (root) {
  const Clippy = (root.Clippy = root.Clippy || {});

  const PATTERNS = [
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
    ['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
    ['Stripe key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
    ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
    ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ];

  function luhn(digits) {
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  function hasCardNumber(text) {
    for (const m of text.matchAll(/(?:\d[ -]?){12,18}\d/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return true;
    }
    return false;
  }

  function entropy(s) {
    const freq = {};
    for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
    let h = 0;
    for (const n of Object.values(freq)) {
      const p = n / s.length;
      h -= p * Math.log2(p);
    }
    return h;
  }

  // A lone random-looking token (mixed case + digits). Plain hex hashes and
  // UUIDs are lowercase-only, so commit SHAs are still recorded.
  function looksLikeSecretToken(text) {
    const t = text.trim();
    if (t.length < 24 || t.length > 256 || /\s/.test(t) || /^https?:/i.test(t)) return false;
    if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/\d/.test(t)) return false;
    return entropy(t) >= 4.2;
  }

  // Returns a short reason string, or null if the text looks fine.
  function detectSensitive(text) {
    if (!text) return null;
    for (const [reason, re] of PATTERNS) if (re.test(text)) return reason;
    if (hasCardNumber(text)) return 'card number';
    if (looksLikeSecretToken(text)) return 'secret-looking token';
    return null;
  }

  Object.assign(Clippy, { detectSensitive });
  if (typeof module !== 'undefined' && module.exports) module.exports = Clippy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
