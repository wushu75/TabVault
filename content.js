// content.js — TabVault content script
// Captures page state metadata when requested; runs passively otherwise

(function() {
  // Listen for state capture requests from background
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CAPTURE_STATE') {
      try {
        const state = {
          title: document.title,
          url: window.location.href,
          scrollY: window.scrollY,
          scrollX: window.scrollX,
          // Don't capture full DOM (privacy + size reasons) — URL is enough to restore
          metaDescription: document.querySelector('meta[name="description"]')?.content || '',
          timestamp: Date.now()
        };
        sendResponse({ ok: true, state });
      } catch (err) {
        sendResponse({ ok: false });
      }
    }
    return false;
  });
})();
