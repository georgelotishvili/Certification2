(() => {
  const globalObject = typeof window !== 'undefined' ? window : {};
  const defaults = {
  API_BASE: 'http://127.0.0.1:8000',
  ABOUT_LABEL: 'წესები და პირობები',
  };

  const metaOverrides = {};
  try {
    const metaConfig = document.querySelector('meta[name="app-config"]');
    if (metaConfig?.content) {
      const parsed = JSON.parse(metaConfig.content);
      if (parsed && typeof parsed === 'object') {
        Object.assign(metaOverrides, parsed);
      }
    }
  } catch {}

  const metaApiBase = document.querySelector('meta[name="api-base"]');
  if (metaApiBase?.content) {
    metaOverrides.API_BASE = metaApiBase.content.trim();
  }

  const existing = (globalObject.APP_CONFIG && typeof globalObject.APP_CONFIG === 'object')
    ? globalObject.APP_CONFIG
    : {};

  const merged = {
    ...defaults,
    ...existing,
    ...metaOverrides,
  };

  globalObject.APP_CONFIG = Object.freeze(merged);

  if (typeof globalObject.APP_CONFIG.API_BASE !== 'string' || !globalObject.APP_CONFIG.API_BASE) {
    globalObject.APP_CONFIG = Object.freeze({
      ...globalObject.APP_CONFIG,
      API_BASE: defaults.API_BASE,
    });
  }
})();


