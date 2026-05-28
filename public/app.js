const API = '/api/v1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
};
const euros = (cents) => fmt.format((cents || 0) / 100);
const parseAmount = (s) => {
  const n = Number(String(s).replace(',', '.').replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};

const state = {
  auth: sessionStorage.getItem('auth') || '',
  current: null,
};

async function api(method, path, body) {
  const opts = {
    method,
    headers: { Authorization: 'Basic ' + state.auth },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  if (res.status === 401) {
    sessionStorage.removeItem('auth');
    state.auth = '';
    show('login');
    throw new Error('Unauthorized');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || res.statusText);
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function show(id) {
  $$('.screen').forEach((s) => (s.hidden = s.id !== id));
}

function openSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
  const input = el.querySelector('input');
  if (input) setTimeout(() => input.focus(), 50);
}
function closeSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = true;
  const form = el.querySelector('form');
  if (form) form.reset();
  const err = el.querySelector('.err');
  if (err) { err.hidden = true; err.textContent = ''; }
}

// ---------- Routes ----------

async function loadHome() {
  try {
    const [p, expenses] = await Promise.all([
      api('GET', '/periods/current'),
      api('GET', '/periods/current/expenses'),
    ]);
    state.current = p;
    renderHome(p);
    renderExpenses($('#expenses'), expenses, { deletable: true });
    show('home');
  } catch (e) {
    if (e.status === 404) {
      show('empty');
    } else if (e.message !== 'Unauthorized') {
      console.error(e);
      alert(e.message);
    }
  }
}

function renderHome(p) {
  $('#periodName').textContent = p.name;
  const remainingEl = $('#remaining');
  remainingEl.textContent = euros(p.remaining);
  remainingEl.classList.toggle('negative', p.remaining < 0);
  $('#spent').textContent = euros(p.spent);
  $('#budget').textContent = euros(p.budget);
  $('#count').textContent = p.expense_count ? `${p.expense_count}` : '';
  const pct = p.budget > 0 ? Math.min(100, Math.max(0, (p.spent / p.budget) * 100)) : 0;
  const fill = $('#barFill');
  fill.style.width = pct + '%';
  fill.classList.toggle('warn', pct >= 75 && pct < 100);
  fill.classList.toggle('over', p.spent > p.budget);
}

function renderExpenses(ul, items, { deletable = false } = {}) {
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty-row';
    li.textContent = 'Aucune dépense';
    ul.appendChild(li);
    return;
  }
  for (const ex of items) {
    const isRefund = ex.amount > 0;
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="label"><span class="l"></span><span class="d"></span></div>
      <span class="amt ${isRefund ? 'pos' : ''}"></span>
    `;
    li.querySelector('.l').textContent = ex.label;
    li.querySelector('.d').textContent = fmtDate(ex.date);
    li.querySelector('.amt').textContent = (isRefund ? '+' : '') + euros(ex.amount);
    if (deletable) {
      makeSwipeable(li, {
        onDelete: async () => {
          try {
            await api('DELETE', `/expenses/${ex.id}`);
            loadHome();
          } catch (e) { alert(e.message); }
        },
      });
    }
    ul.appendChild(li);
  }
}

// ---------- Swipe to delete ----------

const TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v7M14 11v7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ACTION_W = 72;
let openSwipe = null;

function makeSwipeable(li, { onDelete, onTap } = {}) {
  const front = document.createElement('div');
  front.className = 'swipe-front';
  while (li.firstChild) front.appendChild(li.firstChild);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'swipe-action';
  action.setAttribute('aria-label', 'Supprimer');
  action.innerHTML = TRASH_SVG;

  li.classList.add('swipeable');
  li.appendChild(action);
  li.appendChild(front);

  let startX = 0, startY = 0, dx = 0, base = 0;
  let dragging = false, locked = null, isOpen = false, didSwipe = false;

  const setX = (x) => { front.style.transform = `translateX(${x}px)`; };
  const open = () => {
    isOpen = true;
    front.style.transition = '';
    setX(-ACTION_W);
    li.classList.add('swipe-open');
    if (openSwipe && openSwipe !== close) openSwipe();
    openSwipe = close;
  };
  function close() {
    isOpen = false;
    front.style.transition = '';
    setX(0);
    li.classList.remove('swipe-open');
    if (openSwipe === close) openSwipe = null;
  }

  front.addEventListener('touchstart', (e) => {
    if (openSwipe && openSwipe !== close) openSwipe();
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    base = isOpen ? -ACTION_W : 0;
    dx = base;
    dragging = true; locked = null; didSwipe = false;
    front.style.transition = 'none';
  }, { passive: true });

  front.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const ddx = t.clientX - startX;
    const ddy = t.clientY - startY;
    if (locked === null) {
      if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) {
        locked = Math.abs(ddx) > Math.abs(ddy) ? 'x' : 'y';
      }
    }
    if (locked !== 'x') return;
    didSwipe = true;
    dx = Math.min(0, Math.max(-ACTION_W * 1.3, base + ddx));
    setX(dx);
  }, { passive: true });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    front.style.transition = '';
    if (locked === 'x') {
      if (dx < -ACTION_W / 2) open();
      else close();
    }
  };
  front.addEventListener('touchend', finish);
  front.addEventListener('touchcancel', finish);

  front.addEventListener('click', () => {
    if (didSwipe) { didSwipe = false; return; }
    if (isOpen) { close(); return; }
    if (onTap) onTap();
  });

  action.addEventListener('click', () => {
    close();
    onDelete();
  });
}

document.addEventListener('pointerdown', (e) => {
  if (!openSwipe) return;
  const li = e.target.closest('.swipeable.swipe-open');
  if (!li) openSwipe();
}, true);

async function loadHistory() {
  try {
    const list = await api('GET', '/periods');
    const ul = $('#periods');
    ul.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty-row';
      li.textContent = 'Aucune période';
      ul.appendChild(li);
    }
    for (const p of list) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="row1">
          <span class="pname"></span>
          <span class="ptag"></span>
        </div>
        <div class="row2">
          <span class="rem"></span>
          <span class="bg"></span>
        </div>
      `;
      li.querySelector('.pname').textContent = p.name;
      const tag = li.querySelector('.ptag');
      tag.textContent = p.status === 'open' ? 'Ouverte' : 'Close';
      tag.classList.toggle('open', p.status === 'open');
      li.querySelector('.rem').textContent = `Reste ${euros(p.remaining)}`;
      li.querySelector('.bg').textContent = `${euros(p.spent)} / ${euros(p.budget)}`;
      makeSwipeable(li, {
        onTap: () => {
          if (p.status === 'open') loadHome();
          else loadPeriodDetail(p.id);
        },
        onDelete: async () => {
          try {
            await api('DELETE', `/periods/${p.id}`);
            loadHistory();
          } catch (e) { alert(e.message); }
        },
      });
      ul.appendChild(li);
    }
    show('history');
  } catch (e) { if (e.message !== 'Unauthorized') alert(e.message); }
}

async function loadPeriodDetail(id) {
  try {
    const [p, exs] = await Promise.all([
      api('GET', `/periods/${id}`),
      api('GET', `/periods/${id}/expenses`),
    ]);
    $('#detailName').textContent = p.name;
    const r = $('#detailRemaining');
    r.textContent = euros(p.remaining);
    r.classList.toggle('negative', p.remaining < 0);
    $('#detailSpent').textContent = euros(p.spent);
    $('#detailBudget').textContent = euros(p.budget);
    $('#detailCount').textContent = p.expense_count ? `${p.expense_count}` : '';
    renderExpenses($('#detailExpenses'), exs);
    show('periodDetail');
  } catch (e) { if (e.message !== 'Unauthorized') alert(e.message); }
}

// ---------- Wiring ----------

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const u = f.get('username');
  const p = f.get('password');
  state.auth = btoa(`${u}:${p}`);
  sessionStorage.setItem('auth', state.auth);
  $('#loginErr').hidden = true;
  loadHome();
});

$('#historyBtn').addEventListener('click', loadHistory);
$('#newPeriodBtn').addEventListener('click', () => {
  $('#periodSheetTitle').textContent = 'Nouvelle période';
  openSheet('period-sheet');
});
$('#addBtn').addEventListener('click', () => openSheet('expense-sheet'));

$$('[data-open]').forEach((b) => {
  b.addEventListener('click', () => openSheet(b.dataset.open));
});
$$('[data-close]').forEach((b) => {
  b.addEventListener('click', () => {
    const sheet = b.closest('.sheet');
    if (sheet) closeSheet(sheet.id);
  });
});
$$('[data-back]').forEach((b) => b.addEventListener('click', loadHome));
$$('[data-back-history]').forEach((b) => b.addEventListener('click', loadHistory));

$('#expenseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const cents = parseAmount(f.get('amount'));
  const label = String(f.get('label') || '').trim();
  const err = $('#expenseErr');
  if (cents === null || cents <= 0) {
    err.textContent = 'Montant invalide';
    err.hidden = false;
    return;
  }
  if (!label) {
    err.textContent = 'Libellé requis';
    err.hidden = false;
    return;
  }
  try {
    await api('POST', '/periods/current/expenses', { amount: -cents, label });
    closeSheet('expense-sheet');
    loadHome();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#periodForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = String(f.get('name') || '').trim();
  const cents = parseAmount(f.get('budget'));
  const err = $('#periodErr');
  if (!name) { err.textContent = 'Nom requis'; err.hidden = false; return; }
  if (cents === null || cents < 0) { err.textContent = 'Budget invalide'; err.hidden = false; return; }
  try {
    await api('POST', '/periods', { name, budget: cents });
    closeSheet('period-sheet');
    loadHome();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// Boot
if (state.auth) loadHome();
else show('login');
