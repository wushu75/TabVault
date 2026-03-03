// options.js — TabVault Options Page

const DEFAULT_DOMAINS = [
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

let watchlist = [];

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'default') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ─── Load & Save ──────────────────────────────────────────────────────────────
function loadWatchlist() {
  chrome.storage.sync.get(['watchlist'], (result) => {
    watchlist = result.watchlist || DEFAULT_DOMAINS;
    renderDomainList();
  });
}

function saveWatchlist() {
  chrome.storage.sync.set({ watchlist }, () => {
    toast('Saved', 'success');
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderDomainList() {
  const list = document.getElementById('domain-list');
  if (watchlist.length === 0) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:12px;font-family:'IBM Plex Mono',monospace;padding:10px 0">No domains in watchlist</div>`;
    return;
  }

  list.innerHTML = watchlist.map((domain, i) => `
    <div class="domain-item">
      <div class="domain-icon">
        <img src="https://www.google.com/s2/favicons?domain=${escapeAttr(domain)}&sz=16"
             onerror="this.style.display='none'" alt="">
      </div>
      <div class="domain-text">${escapeHtml(domain)}</div>
      <button class="btn-remove" data-index="${i}" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `).join('');

  list.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      watchlist.splice(idx, 1);
      saveWatchlist();
      renderDomainList();
    });
  });
}

// ─── Add domain ───────────────────────────────────────────────────────────────
function addDomain() {
  const input = document.getElementById('new-domain');
  let domain = input.value.trim().toLowerCase();

  // Clean up: strip protocol, trailing slashes
  domain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (domain.endsWith('/')) domain = domain.slice(0, -1);

  if (!domain) { toast('Enter a domain', 'error'); return; }
  if (domain.length < 3) { toast('Domain too short', 'error'); return; }
  if (watchlist.includes(domain)) { toast('Already in watchlist', 'error'); return; }

  // FREEMIUM HOOK: Free tier max 20 domains, paid = unlimited
  if (watchlist.length >= 50) {
    toast('Max domains reached', 'error');
    return;
  }

  watchlist.push(domain);
  saveWatchlist();
  renderDomainList();
  input.value = '';
  input.focus();
}

document.getElementById('btn-add-domain').addEventListener('click', addDomain);
document.getElementById('new-domain').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addDomain();
});

// ─── Destroy vault ────────────────────────────────────────────────────────────
document.getElementById('btn-destroy').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('show');
});

document.getElementById('btn-modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.remove('show');
});

document.getElementById('btn-modal-confirm').addEventListener('click', async () => {
  document.getElementById('modal-overlay').classList.remove('show');
  chrome.runtime.sendMessage({ type: 'CLEAR_VAULT' }, () => {
    chrome.storage.local.remove(['vaultPasswordHash', 'failedAttempts']);
    toast('Vault destroyed', 'error');
  });
});

// Close modal on overlay click
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('modal-overlay').classList.remove('show');
  }
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadWatchlist();
