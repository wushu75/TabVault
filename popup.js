// popup.js — TabVault Popup Logic

const MAX_UNLOCK_ATTEMPTS = 5;

// ─── State ────────────────────────────────────────────────────────────────────
let failedAttempts = 0;
let vaultEntries = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const screens = {
  setup: document.getElementById('screen-setup'),
  lock: document.getElementById('screen-lock'),
  main: document.getElementById('screen-main')
};

// ─── Screen management ────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name]?.classList.add('active');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'default') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Message helpers ──────────────────────────────────────────────────────────
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

// ─── Password strength ────────────────────────────────────────────────────────
function passwordStrength(pw) {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return score;
}

document.getElementById('setup-pw').addEventListener('input', function() {
  const score = passwordStrength(this.value);
  const bar = document.getElementById('pw-strength-bar');
  const colors = ['', '#ff4444', '#ff8800', '#ffcc00', '#88dd00', '#00ff88'];
  const widths = ['0%', '20%', '40%', '60%', '80%', '100%'];
  bar.style.width = widths[score];
  bar.style.background = colors[score];
});

// ─── Toggle password visibility ───────────────────────────────────────────────
document.querySelectorAll('.toggle-pw').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

// ─── Setup: Save password ─────────────────────────────────────────────────────
document.getElementById('btn-setup-save').addEventListener('click', async () => {
  const pw = document.getElementById('setup-pw').value;
  const confirm = document.getElementById('setup-pw-confirm').value;

  if (pw.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }
  if (pw !== confirm) { toast('Passwords do not match', 'error'); return; }

  const { hash } = await sendMessage({ type: 'HASH_PASSWORD', password: pw });
  chrome.storage.local.set({ vaultPasswordHash: hash, failedAttempts: 0 });

  // Set session key (used for actual encryption)
  await sendMessage({ type: 'SET_SESSION_KEY', key: pw });

  toast('Vault activated!', 'success');
  showScreen('main');
  loadVaultEntries();
});

// ─── Unlock ───────────────────────────────────────────────────────────────────
document.getElementById('btn-unlock').addEventListener('click', attemptUnlock);
document.getElementById('unlock-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') attemptUnlock();
});

async function attemptUnlock() {
  const pw = document.getElementById('unlock-pw').value;
  if (!pw) { toast('Enter your password', 'error'); return; }

  const { vaultPasswordHash } = await new Promise(r =>
    chrome.storage.local.get(['vaultPasswordHash'], r)
  );
  const { hash } = await sendMessage({ type: 'HASH_PASSWORD', password: pw });

  if (hash === vaultPasswordHash) {
    // Success
    failedAttempts = 0;
    chrome.storage.local.set({ failedAttempts: 0 });
    document.getElementById('unlock-pw').value = '';
    document.getElementById('attempts-warn').textContent = '';

    await sendMessage({ type: 'SET_SESSION_KEY', key: pw });
    showScreen('main');
    loadVaultEntries();
  } else {
    failedAttempts++;
    chrome.storage.local.set({ failedAttempts });

    const remaining = MAX_UNLOCK_ATTEMPTS - failedAttempts;
    const warn = document.getElementById('attempts-warn');
    const pwInput = document.getElementById('unlock-pw');
    pwInput.classList.add('error');
    setTimeout(() => pwInput.classList.remove('error'), 600);

    if (failedAttempts >= MAX_UNLOCK_ATTEMPTS) {
      // Self-destruct
      await sendMessage({ type: 'CLEAR_VAULT' });
      chrome.storage.local.remove(['vaultPasswordHash', 'failedAttempts']);
      document.getElementById('destruct-overlay').classList.add('show');
    } else {
      warn.textContent = `Wrong password. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`;
      toast('Wrong password', 'error');
    }
  }
}

document.getElementById('btn-destruct-ok').addEventListener('click', () => {
  document.getElementById('destruct-overlay').classList.remove('show');
  showScreen('setup');
});

// ─── WebAuthn ────────────────────────────────────────────────────────────────
document.getElementById('btn-webauthn').addEventListener('click', async () => {
  try {
    // Check if WebAuthn is available
    if (!window.PublicKeyCredential) {
      toast('WebAuthn not available in this context', 'error');
      return;
    }

    // For MVP: use platform authenticator as a "presence check"
    // In production, you'd store a credential ID and use it to derive the vault key
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) {
      toast('No fingerprint / PIN available on this device', 'error');
      return;
    }

    // Create a challenge
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const { vaultPasswordHash } = await new Promise(r =>
      chrome.storage.local.get(['vaultPasswordHash', 'webauthnCredId'], r)
    );

    toast('WebAuthn requires registration first — use password for MVP', 'default');
    // Full WebAuthn flow would register/authenticate here
  } catch (err) {
    toast('Biometric auth failed', 'error');
  }
});

// ─── Load vault entries ───────────────────────────────────────────────────────
async function loadVaultEntries() {
  const { entries } = await sendMessage({ type: 'GET_VAULT_ENTRIES' });
  vaultEntries = entries || [];
  renderVaultList();
}

function renderVaultList() {
  const container = document.getElementById('vault-list-container');
  const count = document.getElementById('vault-entry-count');
  count.textContent = vaultEntries.length;

  if (vaultEntries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="empty-title">No vaulted tabs</div>
        <div class="empty-sub">Press <kbd>Ctrl+Shift+V</kbd> or click<br>VAULT NOW to hide sensitive tabs</div>
      </div>`;
    return;
  }

  const listHTML = `<div class="vault-list">${vaultEntries.map(entry => `
    <div class="vault-item" data-id="${entry.id}">
      <div class="vault-favicon">
        ${entry.domain ? `<img src="https://www.google.com/s2/favicons?domain=${entry.domain}&sz=16" onerror="this.style.display='none'" alt="">` : '🔒'}
      </div>
      <div class="vault-info">
        <div class="vault-title">${escapeHtml(entry.title || 'Untitled Tab')}</div>
        <div class="vault-meta">
          <span class="vault-domain">${escapeHtml(entry.domain || '')}</span>
          <span>${formatTime(entry.vaultedAt)}</span>
        </div>
      </div>
      <div class="vault-actions">
        <button class="item-btn restore" data-id="${entry.id}" title="Restore tab">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14l-5-5 5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
        </button>
        <button class="item-btn delete" data-id="${entry.id}" title="Delete entry">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </div>
    </div>
  `).join('')}</div>`;

  container.innerHTML = listHTML;

  // Attach event listeners
  container.querySelectorAll('.item-btn.restore').forEach(btn => {
    btn.addEventListener('click', () => restoreTab(btn.dataset.id));
  });
  container.querySelectorAll('.item-btn.delete').forEach(btn => {
    btn.addEventListener('click', () => deleteEntry(btn.dataset.id));
  });
}

// ─── Restore tab ──────────────────────────────────────────────────────────────
async function restoreTab(id) {
  const btn = document.querySelector(`.item-btn.restore[data-id="${id}"]`);
  if (btn) { btn.disabled = true; btn.style.opacity = '0.4'; }

  const result = await sendMessage({ type: 'RESTORE_TAB', id });
  if (result?.ok) {
    toast('Tab restored', 'success');
    await loadVaultEntries();
  } else {
    toast('Failed to restore — wrong session key?', 'error');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

// ─── Delete entry ─────────────────────────────────────────────────────────────
async function deleteEntry(id) {
  await sendMessage({ type: 'DELETE_ENTRY', id });
  toast('Entry deleted', 'default');
  vaultEntries = vaultEntries.filter(e => e.id !== id);
  renderVaultList();
}

// ─── Vault now button ─────────────────────────────────────────────────────────
document.getElementById('btn-vault-now').addEventListener('click', async () => {
  const btn = document.getElementById('btn-vault-now');
  btn.disabled = true;
  btn.textContent = 'VAULTING...';

  const result = await sendMessage({ type: 'VAULT_NOW' });

  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7-7 7 7"/></svg> VAULT NOW`;

  if (result?.vaulted > 0) {
    toast(`Vaulted ${result.vaulted} tab${result.vaulted > 1 ? 's' : ''}`, 'success');
    await loadVaultEntries();
  } else if (result?.error === 'no_password') {
    toast('Set a password first', 'error');
  } else {
    toast('No matching tabs found', 'default');
  }
});

// ─── Lock vault ───────────────────────────────────────────────────────────────
document.getElementById('btn-lock').addEventListener('click', async () => {
  await sendMessage({ type: 'SET_SESSION_KEY', key: null });
  chrome.storage.session.remove('sessionKey');
  showScreen('lock');
});

// ─── Options page ─────────────────────────────────────────────────────────────
document.getElementById('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const data = await new Promise(r =>
    chrome.storage.local.get(['vaultPasswordHash', 'failedAttempts', 'pendingVaultAction'], r)
  );

  // Restore failed attempts counter
  failedAttempts = data.failedAttempts || 0;

  // Clear pending vault action flag
  if (data.pendingVaultAction) {
    chrome.storage.local.remove('pendingVaultAction');
  }

  if (!data.vaultPasswordHash) {
    showScreen('setup');
    return;
  }

  // Check if session key is still active
  const { sessionKey } = await new Promise(r =>
    chrome.storage.session.get(['sessionKey'], r)
  );

  if (sessionKey) {
    showScreen('main');
    loadVaultEntries();
  } else {
    showScreen('lock');
    document.getElementById('unlock-pw').focus();
  }
}

init();
