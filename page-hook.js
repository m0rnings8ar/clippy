// Runs in the page's MAIN world. Many "Copy" buttons call
// navigator.clipboard.writeText() and never fire a copy event, so wrap it
// and hand the text to content.js (isolated world) to record.
(() => {
  const clip = navigator.clipboard;
  if (!clip || typeof clip.writeText !== 'function') return;
  const original = clip.writeText;
  clip.writeText = function (text) {
    try {
      window.postMessage({ source: 'clippy-hook', type: 'writeText', text: String(text) }, '*');
    } catch {
      // ignore
    }
    return original.apply(this, arguments);
  };
})();
