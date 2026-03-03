// background.js — TabVault Service Worker
// Handles hotkey command and tab vaulting logic

const DB_NAME = 'TabVaultDB';
const DB_VERSION = 1;
const STORE_NAME = 'vaultedTabs';
const MAX_VAULT_SIZE = 50; // FREEMIUM HOOK: Free tier = 10, paid = unlimited

// ─── IndexedDB helpers ───────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('vaultedAt', 'vaultedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Encryption helpers (Web Crypto API — no external libs needed) ───────────

async function getKey(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const salt = enc.encode('TabVaultSalt_v1'); // deterministic salt for simplicity
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(plaintext, password) {
  const key = await getKey(password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
  );
  // Store iv + ciphertext as base64
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function hashPassword(password) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(password + 'TabVaultPepper'));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

// ─── Domain matching ──────────────────────────────────────────────────────────

function getDefaultDomains() {
  return [
    'indeed.com',
    'linkedin.com/jobs',
    'mint.com',
    'webmd.com',
    'reddit.com/r/HPV',
    'reddit.com/r/jobsearch',
    'reddit.com/r/povertyfinance',
    'reddit.com/r/STD',
    'reddit.com/r/depression',
    'reddit.com/r/survivorsofabuse',
    'glassdoor.com',
    'ziprecruiter.com'
  ];
}

async function getWatchlist() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['watchlist'], (result) => {
      resolve(result.watchlist || getDefaultDomains());
    });
  });
}

function tabMatchesWatchlist(tab, watchlist) {
  if (!tab.url) return false;
  try {
    const url = tab.url.toLowerCase();
    return watchlist.some(domain => url.includes(domain.toLowerCase()));
  } catch {
    return false;
  }
}

// ─── Vault operation ──────────────────────────────────────────────────────────

async function vaultTabs() {
  // Check if password is set
  const { vaultPasswordHash } = await new Promise(resolve =>
    chrome.storage.local.get(['vaultPasswordHash'], resolve)
  );

  if (!vaultPasswordHash) {
    // Signal popup to show setup
    chrome.storage.local.set({ pendingVaultAction: true });
    // Open popup — user must set password first
    chrome.action.openPopup().catch(() => {});
    return { vaulted: 0, error: 'no_password' };
  }

  const watchlist = await getWatchlist();
  const allTabs = await chrome.tabs.query({});
  const matchingTabs = allTabs.filter(t =>
    tabMatchesWatchlist(t, watchlist) &&
    !t.url?.startsWith('chrome://') &&
    !t.url?.startsWith('about:')
  );

  if (matchingTabs.length === 0) return { vaulted: 0 };

  // FREEMIUM HOOK: Check vault size limit (free tier = 10 vaults)
  const currentCount = await dbCount();
  const available = MAX_VAULT_SIZE - currentCount;
  if (available <= 0) {
    // Purge oldest entries to make room
    const all = await dbGetAll();
    all.sort((a, b) => a.vaultedAt - b.vaultedAt);
    const toDelete = all.slice(0, matchingTabs.length);
    for (const item of toDelete) await dbDelete(item.id);
  }

  // Get password for encryption (stored temporarily in session)
  const { sessionKey } = await new Promise(resolve =>
    chrome.storage.session.get(['sessionKey'], resolve)
  );

  const password = sessionKey || 'default_session_key'; // fallback

  let vaultedCount = 0;
  for (const tab of matchingTabs) {
    try {
      const tabData = {
        url: tab.url,
        title: tab.title,
        favIconUrl: tab.favIconUrl || '',
        windowId: tab.windowId,
        index: tab.index
      };
      const plaintext = JSON.stringify(tabData);
      const encrypted = await encryptData(plaintext, password);

      const entry = {
        id: `vault_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        encryptedData: encrypted,
        title: tab.title ? tab.title.substring(0, 60) : 'Unknown Tab', // store title unencrypted for display
        domain: extractDomain(tab.url),
        vaultedAt: Date.now(),
        tabId: tab.id
      };

      await dbPut(entry);

      // Replace tab with blank page (no history entry)
      await chrome.tabs.update(tab.id, { url: 'about:blank' });

      vaultedCount++;
    } catch (err) {
      console.error('TabVault: Failed to vault tab', tab.id, err);
    }
  }

  return { vaulted: vaultedCount };
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'unknown';
  }
}

// ─── Command listener ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'vault-tabs') {
    const result = await vaultTabs();
    if (result.error === 'no_password') return;

    // Store result for popup to display
    chrome.storage.local.set({
      lastVaultResult: result,
      lastVaultTime: Date.now()
    });

    // Show badge briefly
    if (result.vaulted > 0) {
      chrome.action.setBadgeText({ text: `${result.vaulted}` });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
    }
  }
});

// ─── Message handler (from popup) ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_VAULT_ENTRIES': {
        const entries = await dbGetAll();
        entries.sort((a, b) => b.vaultedAt - a.vaultedAt);
        sendResponse({ entries });
        break;
      }
      case 'DELETE_ENTRY': {
        await dbDelete(msg.id);
        sendResponse({ ok: true });
        break;
      }
      case 'CLEAR_VAULT': {
        await dbClear();
        sendResponse({ ok: true });
        break;
      }
      case 'RESTORE_TAB': {
        const db = await openDB();
        const entry = await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get(msg.id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (!entry) { sendResponse({ ok: false, error: 'not_found' }); break; }

        const { sessionKey } = await new Promise(resolve =>
          chrome.storage.session.get(['sessionKey'], resolve)
        );
        const password = sessionKey || 'default_session_key';

        try {
          // Decrypt
          const binary = atob(entry.encryptedData);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const iv = bytes.slice(0, 12);
          const ciphertext = bytes.slice(12);
          const key = await getKey(password);
          const dec = new TextDecoder();
          const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
          const tabData = JSON.parse(dec.decode(plainBuf));

          // Reopen tab
          await chrome.tabs.create({ url: tabData.url, active: false });
          await dbDelete(msg.id);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: 'decrypt_failed' });
        }
        break;
      }
      case 'SET_SESSION_KEY': {
        await chrome.storage.session.set({ sessionKey: msg.key });
        sendResponse({ ok: true });
        break;
      }
      case 'VAULT_NOW': {
        const result = await vaultTabs();
        sendResponse(result);
        break;
      }
      case 'HASH_PASSWORD': {
        const hash = await hashPassword(msg.password);
        sendResponse({ hash });
        break;
      }
      default:
        sendResponse({ error: 'unknown_message' });
    }
  })();
  return true; // async response
});
