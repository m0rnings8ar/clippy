// Settings defaults shared by the service worker, content script and popup.
// Load after lib/cleanup.js.
(function (root) {
  const Clippy = (root.Clippy = root.Clippy || {});

  Clippy.DEFAULT_SETTINGS = {
    recording: true,
    historyLimit: 200,
    skipSensitive: true,
    excludedHosts: [],
    triggerExpansion: true,
    triggerPrefix: ';',
    defaultCleanup: Clippy.DEFAULT_CLEANUP || ['stripInvisible', 'stripTracking', 'trim'],
  };

  Clippy.withDefaults = (settings) => ({ ...Clippy.DEFAULT_SETTINGS, ...(settings || {}) });

  if (typeof module !== 'undefined' && module.exports) module.exports = Clippy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
