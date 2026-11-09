'use strict';
/* pamssh-mcp admin UI. Plain DOM, no build step, no innerHTML with data. */

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by the page's CSP (style attributes are not)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected', 'readOnly', 'open'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** replaceChildren that skips null/false (the DOM would print them as text). */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

/** Text with `inline code` rendered as <code>. */
function rich(text) {
  const frag = document.createDocumentFragment();
  String(text || '').split('`').forEach((part, i) => {
    if (!part) return;
    frag.append(i % 2 ? h('code', { text: part }) : document.createTextNode(part));
  });
  return frag;
}

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const getIn = (o, p) => p.reduce((a, k) => (a == null ? undefined : a[k]), o);
function canon(x) {
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}
const pathKey = (p) => JSON.stringify(p.map(String));
const startsWith = (p, prefix) => prefix.length <= p.length && prefix.every((k, i) => String(p[i]) === String(k));

function keepEmpty(p) {
  return p.length === 0 || (p.length === 1 && (p[0] === 'targets' || p[0] === 'pamServers'))
    || (p.length === 2 && (p[0] === 'targets' || p[0] === 'pamServers'));
}
function setIn(obj, p, value) {
  let o = obj;
  for (const k of p.slice(0, -1)) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  if (value === undefined) delete o[p.at(-1)];
  else o[p.at(-1)] = value;
  // prune empty objects left behind
  for (let i = p.length - 1; i > 0; i--) {
    const parentPath = p.slice(0, i);
    const v = getIn(obj, parentPath);
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 && !keepEmpty(parentPath)) {
      delete getIn(obj, parentPath.slice(0, -1))[parentPath.at(-1)];
    } else break;
  }
}
function renameKey(obj, from, to) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

function humanMs(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '';
  if (ms === 0) return '0';
  if (ms < 1000) return `${ms} 毫秒`;
  const s = ms / 1000;
  if (s < 60) return `${+s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分钟`;
  const hh = Math.floor(m / 60);
  return m % 60 ? `${hh} 小时 ${m % 60} 分` : `${hh} 小时`;
}
function humanMin(min) {
  if (min === undefined || min === null || Number.isNaN(min)) return '';
  if (min === 0) return '永不';
  if (min < 60) return `${min} 分钟`;
  const hh = Math.floor(min / 60);
  return min % 60 ? `${hh} 小时 ${min % 60} 分钟` : `${hh} 小时`;
}
function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(iso).toLocaleString();
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} 天 ${hh} 小时` : hh ? `${hh} 小时 ${m} 分钟` : `${m} 分钟`;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(`pamssh.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`pamssh.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- API ----------
class ApiError extends Error {}
async function api(method, path, body) {
  let r;
  try {
    r = await fetch(`/admin/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-pamssh-admin': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('无法连接服务器（服务可能已停止）');
  }
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && path !== '/login' && path !== '/session') {
    showLogin('登录已过期，请重新登录（未保存的修改会保留）');
    throw new ApiError('未登录');
  }
  if (!r.ok) {
    const e = new ApiError((j && j.error) || `${r.status} ${r.statusText}`);
    e.status = r.status;
    e.data = j;
    throw e;
  }
  return j;
}

// ---------- state ----------
const S = {
  meta: null,
  saved: null,
  draft: null,
  version: null,
  v: { ok: true, issues: [], warnings: [], preview: [], restartRequired: [] },
  tab: 'overview',
  sel: { target: null, pam: null },
  showHelp: store.get('showHelp', true),
  restartNotice: [],
  timers: [],
  revealed: {},
};
const TABS = [
  ['overview', '概览'],
  ['targets', '目标'],
  ['pams', 'PAM 服务器'],
  ['settings', '全局设置'],
  ['sessions', '会话'],
  ['shell', '终端'],
  ['audit', '审计日志'],
  ['hostkeys', '主机指纹'],
  ['logs', '服务日志'],
  ['json', '配置文件'],
  ['backups', '备份'],
];
const dirty = () => S.draft && S.saved && canon(S.draft) !== canon(S.saved);
const MASK = () => S.meta.secretMask;

// ---------- toasts & modals ----------
function toast(text, kind = 'info', ms = 4500) {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, typeof text === 'string' ? rich(text) : text);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
function modal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') close(undefined);
      // Enter in a single-line field submits the dialog's primary action
      if (e.key === 'Enter' && !e.isComposing && e.target.tagName === 'INPUT' && back.contains(e.target)) {
        e.preventDefault();
        back.querySelector('.modal-foot .btn.primary')?.click();
      }
    };
    const foot = h('div', { class: 'modal-foot' },
      actions.map((a) => h('button', {
        class: `btn ${a.kind || ''}`, text: a.label, type: 'button',
        onclick: async () => { if (a.onClick) { const r = await a.onClick(); if (r === false) return; } close(a.value); },
      })));
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(undefined); } },
      h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal-head', text: title }),
        h('div', { class: 'modal-body' }, body),
        actions.length ? foot : null));
    document.body.append(back);
    document.addEventListener('keydown', onKey);
    const first = back.querySelector('input, textarea, select');
    (first || back.querySelector('.btn.primary'))?.focus();
  });
}
const confirmBox = (title, text, okLabel = '确定', kind = 'primary') => modal({
  title,
  body: typeof text === 'string' ? h('div', { style: 'white-space:pre-line' }, rich(text)) : text,
  actions: [{ label: '取消', value: false }, { label: okLabel, value: true, kind }],
});
async function promptId(title, help, initial = '', existing = []) {
  const re = new RegExp(S.meta.fields.idPattern);
  const input = h('input', { type: 'text', value: initial, placeholder: '例如 web-01', spellcheck: 'false' });
  const err = h('div', { class: 'fissues' });
  const check = () => {
    const v = input.value.trim();
    put(err);
    if (!v) return err.append(h('div', { class: 'msg error', text: '不能为空' })), null;
    if (!re.test(v)) return err.append(h('div', { class: 'msg error', text: S.meta.fields.idHelp })), null;
    if (existing.includes(v)) return err.append(h('div', { class: 'msg error', text: `"${v}" 已存在` })), null;
    return v;
  };
  let value = null;
  const ok = await modal({
    title,
    body: h('div', {}, h('div', { class: 'help', style: 'margin:0 0 8px' }, rich(help)), input, err),
    actions: [{ label: '取消', value: false }, { label: '确定', value: true, kind: 'primary', onClick: () => { value = check(); return value !== null; } }],
  });
  return ok ? value : null;
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok', 2000);
  } catch {
    toast('复制失败，请手动选择复制', 'error');
  }
}

// ---------- login ----------
function showLogin(message) {
  stopTimers();
  let wrap = document.querySelector('.login-overlay');
  if (wrap) return;
  const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: '管理令牌', 'aria-label': '管理令牌' });
  const err = h('div', { class: 'fissues' }, message ? h('div', { class: 'msg warn' }, rich(message)) : null);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      put(err);
      try {
        await api('POST', '/login', { token: input.value });
        wrap.remove();
        input.value = '';
        await start();
      } catch (ex) {
        err.append(h('div', { class: 'msg error' }, rich(ex.message)));
        input.select();
      }
    },
  }, input, err, h('button', { class: 'btn primary', type: 'submit', text: '登录' }));
  wrap = h('div', { class: 'login-overlay modal-back', style: 'background: var(--bg)' },
    h('div', { class: 'card login' }, h('div', { class: 'card-body' },
      h('h1', { text: 'pamssh-mcp 管理台' }),
      h('p', {}, rich('使用管理令牌登录。在运行服务的机器上执行 `pamssh-mcp token --admin` 查看令牌。令牌只用于换取登录会话，不会保存在浏览器中。')),
      form)));
  document.body.append(wrap);
  input.focus();
}

// ---------- boot ----------
async function boot() {
  const app = document.getElementById('app');
  let s;
  try {
    s = await api('GET', '/session');
  } catch (e) {
    put(app, h('div', { class: 'boot', text: e.message }));
    return;
  }
  if (!s.enabled) {
    put(app, h('div', { class: 'login-wrap' }, h('div', { class: 'card login' }, h('div', { class: 'card-body' },
      h('h1', { text: '管理页面未启用' }),
      h('p', {}, rich('配置文件中没有 `server.adminToken`。在运行服务的机器上执行 `pamssh-mcp token --admin --rotate` 生成令牌，然后重启 `pamssh-mcp serve`。'))))));
    return;
  }
  if (!s.authenticated) {
    put(app);
    showLogin();
    return;
  }
  await start();
}

async function start() {
  const [meta, cfg] = await Promise.all([api('GET', '/meta'), api('GET', '/config')]);
  S.meta = meta;
  if (!S.draft || !dirty()) {
    S.saved = cfg.raw;
    S.draft = clone(cfg.raw);
    S.version = cfg.version;
  } else {
    // keep unsaved edits made before the login expired
    S.saved = cfg.raw;
    S.version = cfg.version;
  }
  readHash();
  renderShell();
  await validateNow();
  render();
}

function readHash() {
  const [tab, id] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (TABS.some(([t]) => t === tab)) S.tab = tab;
  if (id && S.tab === 'targets') S.sel.target = id;
  if (id && S.tab === 'pams') S.sel.pam = id;
}
function writeHash() {
  const id = S.tab === 'targets' ? S.sel.target : S.tab === 'pams' ? S.sel.pam : null;
  const next = `#${S.tab}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

// ---------- shell ----------
let mainEl;
let navEl;
let saveEl;
function renderShell() {
  const app = document.getElementById('app');
  navEl = h('nav', { class: 'sidebar', 'aria-label': '导航' });
  mainEl = h('main', { class: S.showHelp ? '' : 'hide-help' });
  saveEl = h('div', { class: 'savebar', hidden: true });
  const helpBtn = h('button', {
    class: 'btn small', type: 'button', text: S.showHelp ? '隐藏字段说明' : '显示字段说明',
    onclick: () => {
      S.showHelp = !S.showHelp;
      store.set('showHelp', S.showHelp);
      mainEl.classList.toggle('hide-help', !S.showHelp);
      helpBtn.textContent = S.showHelp ? '隐藏字段说明' : '显示字段说明';
    },
  });
  put(app, 
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, 'pamssh-mcp 管理台', h('small', { text: `v${S.meta.version}` })),
      h('div', { class: 'spacer' }),
      helpBtn,
      h('button', {
        class: 'btn small', type: 'button', text: '退出登录',
        onclick: async () => {
          if (dirty() && !(await confirmBox('退出登录', '有未保存的修改，退出后会丢失。确定退出？', '退出', 'danger'))) return;
          await api('POST', '/logout').catch(() => {});
          S.draft = null;
          location.hash = '';
          location.reload();
        },
      })),
    h('div', { class: 'layout' }, navEl, mainEl),
    saveEl,
  );
  if (S.listening) return;
  S.listening = true;
  window.addEventListener('hashchange', () => { readHash(); render(); });
  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty()) save(); }
  });
}

function tabOfPath(p) {
  if (p[0] === 'targets') return 'targets';
  if (p[0] === 'pamServers') return 'pams';
  return 'settings';
}
function renderNav() {
  const errs = {};
  const warns = {};
  for (const i of S.v.issues) errs[tabOfPath(i.path)] = (errs[tabOfPath(i.path)] || 0) + 1;
  for (const w of S.v.warnings) if (w.level === 'warn') warns[tabOfPath(w.path)] = (warns[tabOfPath(w.path)] || 0) + 1;
  put(navEl, ...TABS.map(([id, label]) => h('button', {
    type: 'button', class: S.tab === id ? 'active' : '',
    onclick: () => go(id),
  }, label,
  errs[id] ? h('span', { class: 'count err', text: errs[id], title: `${errs[id]} 个错误` })
    : warns[id] ? h('span', { class: 'count warn', text: warns[id], title: `${warns[id]} 个警告` }) : null)));
}

function go(tab, sel) {
  S.tab = tab;
  if (sel !== undefined && tab === 'targets') S.sel.target = sel;
  if (sel !== undefined && tab === 'pams') S.sel.pam = sel;
  render();
}

function stopTimers() {
  for (const t of S.timers) clearInterval(t);
  S.timers = [];
}

function render() {
  stopTimers();
  writeHash();
  renderNav();
  const pages = { overview, targets, pams, settings, sessions, shell, audit, hostkeys, logs, json, backups };
  const y = window.scrollY;
  put(mainEl);
  if (S.restartNotice.length) {
    mainEl.append(h('div', { class: 'banner warn' },
      `以下修改需要重启 pamssh-mcp serve 才能生效：${S.restartNotice.map((r) => r.path.join('.')).join('、')}`));
  }
  pages[S.tab]();
  mainEl.insertBefore(h('div', { id: 'unplaced' }), mainEl.querySelector('.page-head'));
  applyIssues();
  renderSavebar();
  if (S._keepScroll) window.scrollTo(0, y);
  S._keepScroll = false;
}

// ---------- validation ----------
let vTimer;
function changed({ structural = false } = {}) {
  renderSavebar();
  clearTimeout(vTimer);
  vTimer = setTimeout(async () => {
    await validateNow();
    if (structural) { S._keepScroll = true; render(); } else { renderNav(); applyIssues(); renderSavebar(); refreshPreviews(); }
  }, 350);
  if (structural) { S._keepScroll = true; render(); }
}
async function validateNow() {
  try {
    const r = await api('POST', '/config/validate', { raw: S.draft });
    S.v = { ok: r.ok, issues: r.issues || [], warnings: r.warnings || [], preview: r.preview || S.v.preview || [], restartRequired: r.restartRequired || [] };
  } catch (e) {
    if (e.message !== '未登录') toast(`校验失败：${e.message}`, 'error');
  }
}

/** Attach each issue/warning to the deepest rendered field whose path prefixes it. */
function applyIssues() {
  const fields = [...mainEl.querySelectorAll('[data-path]')].map((el) => ({ el, path: JSON.parse(el.dataset.path) }));
  for (const f of fields) {
    const box = f.el.querySelector(':scope > .fissues');
    if (box) put(box);
    f.el.classList.remove('has-error');
  }
  const unplaced = [];
  const place = (item, kind) => {
    let best = null;
    for (const f of fields) {
      if (!f.el.querySelector(':scope > .fissues')) continue;
      if (startsWith(item.path, f.path) && (!best || f.path.length > best.path.length)) best = f;
    }
    if (!best) {
      if (kind === 'error') unplaced.push(item);
      return;
    }
    const box = best.el.querySelector(':scope > .fissues');
    const rel = item.path.slice(best.path.length);
    const where = rel.length ? `第 ${Number(rel[0]) + 1 || rel.join('.')} 项：` : '';
    box.append(h('div', { class: `msg ${kind}` }, where, rich(item.message)));
    if (kind === 'error') best.el.classList.add('has-error');
  };
  for (const i of S.v.issues) place(i, 'error');
  for (const w of S.v.warnings) place(w, w.level === 'warn' ? 'warn' : 'info');
  // errors that belong to this page but have no field on it (e.g. unknown keys)
  const holder = mainEl.querySelector('#unplaced');
  if (holder) {
    const sel = S.tab === 'targets' ? S.sel.target : S.tab === 'pams' ? S.sel.pam : null;
    const mine = unplaced.filter((i) => tabOfPath(i.path) === S.tab && (!sel || i.path.length < 2 || i.path[1] === sel));
    put(holder, ...(mine.length ? [h('div', { class: 'banner error' },
      h('div', {}, '以下问题没有对应的表单字段，可以在“配置文件”页直接修改：',
        mine.map((i) => h('div', {}, h('code', { text: i.path.join('.') || '（根）' }), ' ', i.message))))] : []));
  }
  refreshListDots();
}

function issueSummary(prefix) {
  const e = S.v.issues.filter((i) => startsWith(i.path, prefix)).length;
  const w = S.v.warnings.filter((i) => i.level === 'warn' && startsWith(i.path, prefix)).length;
  return { e, w };
}
function refreshListDots() {
  for (const el of mainEl.querySelectorAll('[data-dot]')) {
    const { e, w } = issueSummary(JSON.parse(el.dataset.dot));
    el.className = `dot ${e ? 'err' : w ? 'warn' : 'ok'}`;
    el.title = e ? `${e} 个错误` : w ? `${w} 个警告` : '无问题';
  }
}

function diffPaths(a, b, p = [], out = []) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], [...p, k], out);
  } else if (canon(a) !== canon(b)) {
    out.push({ path: p, kind: a === undefined ? '新增' : b === undefined ? '删除' : '修改', before: a, after: b });
  }
  return out;
}

function renderSavebar() {
  if (!saveEl) return;
  const d = dirty();
  saveEl.hidden = !d;
  if (!d) return;
  const changes = diffPaths(S.saved, S.draft);
  const errs = S.v.issues.length;
  const status = errs
    ? h('span', { class: 'status' }, h('span', { class: 'badge err', text: `${errs} 个错误` }), ' ',
      h('button', { class: 'linkish', type: 'button', text: '定位第一个', onclick: () => goToPath(S.v.issues[0].path) }))
    : h('span', { class: 'status' }, h('span', { class: 'badge ok', text: '校验通过' }));
  put(saveEl, 
    h('span', { class: 'status' }, '未保存的修改：',
      h('button', { class: 'linkish', type: 'button', text: `${changes.length} 处`, onclick: () => showChanges(changes) })),
    status,
    S.v.restartRequired.length ? h('span', { class: 'badge restart', text: '含需重启的修改' }) : null,
    h('span', { class: 'grow' }),
    h('button', {
      class: 'btn', type: 'button', text: '放弃修改',
      onclick: async () => {
        if (!(await confirmBox('放弃修改', `放弃全部 ${changes.length} 处未保存的修改？`, '放弃', 'danger'))) return;
        S.draft = clone(S.saved);
        await validateNow();
        render();
      },
    }),
    h('button', { class: 'btn primary', type: 'button', text: '保存并应用', disabled: errs > 0, title: '⌘/Ctrl + S', onclick: save }),
  );
}

function showChanges(changes) {
  const fmt = (v) => (v === undefined ? '（未设置）' : v === MASK() ? '（已隐藏）' : JSON.stringify(v));
  modal({
    title: `未保存的修改（${changes.length} 处）`,
    wide: true,
    body: h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: '字段' }), h('th', { text: '类型' }), h('th', { text: '原值' }), h('th', { text: '新值' }))),
      h('tbody', {}, changes.map((c) => h('tr', {},
        h('td', { class: 'mono' }, h('button', { class: 'linkish', type: 'button', text: c.path.join('.'), onclick: () => { document.querySelector('.modal-back')?.remove(); goToPath(c.path); } })),
        h('td', { text: c.kind }),
        h('td', { class: 'mono', text: fmt(c.before) }),
        h('td', { class: 'mono', text: fmt(c.after) })))))),
    actions: [{ label: '关闭', value: true }],
  });
}

async function save() {
  if (S.saving) return;
  S.saving = true;
  try {
    const r = await api('PUT', '/config', { raw: S.draft, baseVersion: S.version });
    const cfg = await api('GET', '/config');
    S.saved = cfg.raw;
    S.draft = clone(cfg.raw);
    S.version = cfg.version;
    S.revealed = {};
    S.restartNotice = r.applied.restartRequired;
    await validateNow();
    render();
    toast('已保存并应用。新配置对下一条命令生效。', 'ok');
    if (r.applied.closedSessions.length) toast(`已关闭已删除目标的会话：${r.applied.closedSessions.join('、')}`, 'warn', 8000);
    if (r.applied.staleSessions.length) {
      toast(`${r.applied.staleSessions.length} 个会话仍按旧的连接参数运行（${r.applied.staleSessions.join('、')}），在“会话”页关闭后会按新配置重连。`, 'warn', 10000);
    }
  } catch (e) {
    if (e.status === 409) {
      const reload = await modal({
        title: '配置文件已被修改',
        body: h('div', {}, rich('在你编辑期间，配置文件被其他人或进程修改了（例如手工编辑或另一个管理页面）。为避免覆盖对方的修改，本次没有保存。')),
        actions: [{ label: '取消', value: false }, { label: '重新加载（丢弃我的修改）', value: true, kind: 'danger' }],
      });
      if (reload) {
        const cfg = await api('GET', '/config');
        S.saved = cfg.raw; S.draft = clone(cfg.raw); S.version = cfg.version;
        await validateNow();
        render();
      }
    } else if (e.status === 400 && e.data?.issues) {
      S.v.issues = e.data.issues;
      render();
      toast(e.message, 'error');
    } else if (e.message !== '未登录') {
      toast(`保存失败：${e.message}`, 'error', 8000);
    }
  } finally {
    S.saving = false;
  }
}

function goToPath(p) {
  const tab = tabOfPath(p);
  if (tab === 'targets') S.sel.target = p[1];
  if (tab === 'pams') S.sel.pam = p[1];
  if (S.tab !== tab || (tab !== 'settings')) { S.tab = tab; render(); }
  requestAnimationFrame(() => {
    let best = null;
    let bestLen = -1;
    for (const el of mainEl.querySelectorAll('[data-path]')) {
      const fp = JSON.parse(el.dataset.path);
      if (startsWith(p, fp) && fp.length > bestLen) { best = el; bestLen = fp.length; }
    }
    if (best) {
      let det = best.closest('details');
      while (det) { det.open = true; det = det.parentElement.closest('details'); }
      best.scrollIntoView({ block: 'center', behavior: 'smooth' });
      best.classList.add('flash');
      setTimeout(() => best.classList.remove('flash'), 1700);
      best.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    }
  });
}

// ---------- generic field renderer ----------
const fieldIndex = () => {
  const idx = {};
  for (const sec of S.meta.fields.globalSections) for (const f of sec.fields) idx[[...sec.path, f.key].join('.')] = f;
  return idx;
};
function inheritedValue(f) {
  const v = getIn(S.draft, f.inherit.split('.'));
  if (v !== undefined) return v;
  return fieldIndex()[f.inherit]?.default;
}
function defaultLabel(f) {
  if (f.inherit) return `继承全局：${fmtVal(inheritedValue(f), f)}`;
  if (f.defaultText) return f.defaultText;
  if (f.default === undefined) return '';
  if (Array.isArray(f.default)) return f.default.length ? f.default.join(', ') : '（空）';
  if (f.default === '') return '（空）';
  return fmtVal(f.default, f);
}
function fmtVal(v, f) {
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (f?.unit === 'ms') return `${v}（${humanMs(v)}）`;
  if (f?.unit === 'min') return `${v}（${humanMin(v)}）`;
  if (f?.unit === 'day') return v === 0 ? '0（永久保留）' : `${v} 天`;
  return String(v);
}

function renderFields(fields, base, ctx = {}) {
  const normal = fields.filter((f) => !f.advanced);
  const adv = fields.filter((f) => f.advanced);
  const out = normal.map((f) => renderField(f, base, ctx));
  if (adv.length) {
    const anySet = adv.some((f) => getIn(S.draft, [...base, f.key]) !== undefined);
    out.push(h('details', { class: 'adv', open: anySet }, h('summary', { text: `高级选项（${adv.length}）` }),
      adv.map((f) => renderField(f, base, ctx))));
  }
  return out;
}

function renderField(f, base, ctx) {
  const path = [...base, f.key];
  if (f.type === 'group') {
    return h('div', { class: 'field', 'data-path': pathKey(path) },
      h('fieldset', { class: 'group' },
        h('legend', {}, f.label, ' ', h('span', { class: 'key', text: f.key })),
        f.help ? h('div', { class: 'help' }, rich(f.help)) : null,
        renderFields(f.fields, path, ctx),
        ctx.groupExtra?.[f.key]?.(path)),
      h('div', { class: 'fissues' }));
  }
  const value = getIn(S.draft, path);
  const env = f.env && S.meta.envOverrides.find((o) => o.name === f.env);
  const head = h('div', { class: 'field-head' },
    h('label', { for: `f-${path.join('-')}`, text: f.label }),
    h('span', { class: 'key', text: f.key }),
    f.required ? h('span', { class: 'badge req', text: '必填' }) : null,
    f.restart ? h('span', { class: 'badge restart', text: '需重启生效' }) : null,
    env ? h('span', { class: 'badge env', text: `被环境变量 ${f.env} 覆盖` }) : null,
    value !== undefined && !f.required && f.type !== 'secret'
      ? h('button', {
        class: 'btn ghost small', type: 'button', text: f.inherit ? '恢复继承' : '恢复默认', title: '删除此字段，使用默认值',
        onclick: () => { setIn(S.draft, path, undefined); changed({ structural: true }); },
      }) : null);
  const hints = h('div', { class: 'hints' });
  const control = renderControl(f, path, value, hints, ctx);
  const dl = defaultLabel(f);
  const hintItems = [];
  if (dl && f.type !== 'secret') hintItems.push(h('span', {}, f.inherit ? '' : '默认：', dl));
  if (f.example) hintItems.push(h('span', {}, '示例：', h('code', { text: f.example.replace(/\n/g, ' ⏎ ') })));
  if (f.min !== undefined || f.max !== undefined) {
    hintItems.push(h('span', { text: `范围：${f.min ?? '—'} ~ ${f.max ?? '∞'}` }));
  }
  hints.prepend(...hintItems);
  return h('div', { class: 'field', 'data-path': pathKey(path) },
    head, control,
    f.help ? h('div', { class: 'help' }, rich(f.help)) : null,
    env ? h('div', { class: 'caution' }, rich(`当前进程设置了环境变量 \`${f.env}\`，实际生效的是环境变量的值；这里的修改会写入配置文件，但在去掉环境变量前不会生效。`)) : null,
    f.warn ? h('div', { class: 'caution' }, rich(f.warn)) : null,
    hints,
    h('div', { class: 'fissues' }));
}

function renderControl(f, path, value, hints, ctx) {
  const id = `f-${path.join('-')}`;
  const set = (v, structural) => { setIn(S.draft, path, v); changed({ structural }); };
  const placeholder = f.placeholder || defaultLabel(f);
  switch (f.type) {
    case 'string': {
      const input = h('input', { id, type: 'text', value: value ?? '', placeholder, spellcheck: 'false', oninput: (e) => set(e.target.value === '' ? undefined : e.target.value) });
      if (f.picker === 'agentKey') {
        return h('div', { class: 'inline-row' }, input,
          h('button', { class: 'btn', type: 'button', text: '从 SSH Agent 选择', onclick: () => pickAgentKey(path, ctx) }));
      }
      return input;
    }
    case 'int':
    case 'number': {
      const human = h('span', { class: 'human' });
      const upd = (v) => {
        human.textContent = v === undefined ? ''
          : f.unit === 'ms' ? `= ${humanMs(v)}`
            : f.unit === 'min' ? `= ${humanMin(v)}`
              : f.unit === 'day' ? (v === 0 ? '= 永久保留' : `= ${v} 天`) : '';
      };
      upd(value);
      hints.append(human);
      return h('input', {
        id, type: 'number', value: value ?? '', placeholder, step: f.type === 'int' ? '1' : 'any', min: f.min, max: f.max,
        oninput: (e) => {
          if (e.target.value === '') { upd(undefined); return set(undefined); }
          const n = Number(e.target.value);
          if (Number.isNaN(n)) return undefined;
          upd(n);
          return set(n);
        },
      });
    }
    case 'bool':
      return h('select', { id, onchange: (e) => set(e.target.value === '' ? undefined : e.target.value === 'true') },
        h('option', { value: '', text: `默认（${f.default ? '是' : '否'}）`, selected: value === undefined }),
        h('option', { value: 'true', text: '是', selected: value === true }),
        h('option', { value: 'false', text: '否', selected: value === false }));
    case 'enum':
      return h('select', { id, onchange: (e) => set(e.target.value === '' ? undefined : e.target.value) },
        h('option', { value: '', text: `默认（${f.options.find((o) => o.value === f.default)?.label ?? f.default ?? '无'}）`, selected: value === undefined }),
        f.options.map((o) => h('option', { value: o.value, text: o.label, selected: value === o.value })));
    case 'pamRef': {
      const ids = Object.keys(S.draft.pamServers || {});
      return h('select', { id, onchange: (e) => set(e.target.value === '' ? undefined : e.target.value) },
        h('option', { value: '', text: ids.length === 1 ? `自动（唯一的 PAM 服务器：${ids[0]}）` : '请选择', selected: value === undefined }),
        ids.map((p) => h('option', { value: p, text: p, selected: value === p })),
        value !== undefined && !ids.includes(value) ? h('option', { value, text: `${value}（不存在）`, selected: true }) : null);
    }
    case 'tags':
      return h('input', {
        id, type: 'text', value: (value || []).join(', '), placeholder: '例如 prod, web', spellcheck: 'false',
        oninput: (e) => { const t = e.target.value.split(/[,\s，]+/).filter(Boolean); set(t.length ? t : undefined); },
      });
    case 'list':
    case 'regexList':
    case 'stringOrList': {
      const lines = value === undefined ? [] : Array.isArray(value) ? value : [value];
      const ta = h('textarea', {
        id, rows: Math.max(2, lines.length + 1), spellcheck: 'false', placeholder: f.type === 'stringOrList' ? '每行一个' : (placeholder || '每行一个'),
        oninput: (e) => {
          const ls = e.target.value.split('\n').map((l) => (f.type === 'regexList' ? l.replace(/\r$/, '') : l.trim())).filter((l) => l.trim() !== '');
          if (f.type === 'stringOrList') set(ls.length === 0 ? undefined : ls.length === 1 ? ls[0] : ls);
          else set(ls.length ? ls : undefined);
        },
      });
      ta.value = lines.join('\n');
      return h('div', {}, ta, h('div', { class: 'hints' }, h('span', { text: f.type === 'regexList' ? '每行一条正则，保存前会逐条校验' : '每行一项' })));
    }
    case 'json': {
      const err = h('div', { class: 'fissues' });
      const ta = h('textarea', {
        id, rows: 4, spellcheck: 'false', placeholder: f.example || '{}',
        oninput: (e) => {
          put(err);
          const t = e.target.value.trim();
          if (!t) return set(undefined);
          try { set(JSON.parse(t)); } catch (ex) { err.append(h('div', { class: 'msg error', text: `JSON 无效：${ex.message}（未应用）` })); }
          return undefined;
        },
      });
      ta.value = value === undefined ? '' : JSON.stringify(value, null, 2);
      return h('div', {}, ta, err);
    }
    case 'secret':
      return renderSecret(f, path, value);
    default:
      return h('div', { class: 'msg error', text: `未知字段类型 ${f.type}` });
  }
}

function renderSecret(f, path, value) {
  const name = f.key;
  const box = h('div', {});
  const draw = () => {
    const v = getIn(S.draft, path);
    const savedV = getIn(S.saved, path);
    const isMask = v === MASK();
    const shown = isMask ? S.revealed[name] : v;
    const state = v === undefined ? h('span', { class: 'badge err', text: '未设置' })
      : isMask ? h('span', { class: 'badge ok', text: '已设置' })
        : h('span', { class: 'badge restart', text: savedV === undefined ? '新设置（未保存）' : '已更换（未保存）' });
    const row = h('div', { class: 'btn-row' }, state);
    if (isMask && !S.revealed[name]) {
      row.append(h('button', {
        class: 'btn small', type: 'button', text: '显示',
        onclick: async () => {
          try { S.revealed[name] = (await api('POST', '/secret/reveal', { name })).value; draw(); } catch (e) { toast(e.message, 'error'); }
        },
      }));
    }
    if (shown) row.append(h('button', { class: 'btn small', type: 'button', text: '复制', onclick: () => copy(shown) }));
    if (isMask && S.revealed[name]) row.append(h('button', { class: 'btn small', type: 'button', text: '隐藏', onclick: () => { delete S.revealed[name]; draw(); } }));
    row.append(h('button', {
      class: 'btn small', type: 'button', text: '生成新令牌',
      onclick: async () => {
        const consequence = name === 'authToken'
          ? '保存后旧令牌立即失效，所有已接入的 agent 都需要换成新令牌（`pamssh-mcp token` 可再次查看）。'
          : '保存后旧令牌立即失效，其他浏览器里已登录的管理会话会被注销；当前页面保持登录。';
        if (!(await confirmBox('生成新令牌', consequence, '生成'))) return;
        const { value: nv } = await api('POST', '/token/generate');
        setIn(S.draft, path, nv);
        changed();
        draw();
      },
    }));
    row.append(h('button', {
      class: 'btn small', type: 'button', text: '手动输入',
      onclick: () => {
        const input = h('input', { type: 'text', placeholder: '至少 16 个字符', spellcheck: 'false' });
        modal({
          title: `设置${f.label}`,
          body: h('div', {}, input, h('div', { class: 'help' }, rich('建议使用“生成新令牌”。手动设置时请使用足够长的随机字符串。'))),
          actions: [{ label: '取消', value: false }, {
            label: '确定', kind: 'primary', value: true,
            onClick: () => { if (input.value.trim().length < 16) { toast('至少 16 个字符', 'error'); return false; } setIn(S.draft, path, input.value.trim()); changed(); draw(); return true; },
          }],
        });
      },
    }));
    if (savedV !== undefined && v !== savedV) {
      row.append(h('button', { class: 'btn small ghost', type: 'button', text: '撤销更换', onclick: () => { setIn(S.draft, path, savedV); changed(); draw(); } }));
    }
    if (v !== undefined) {
      row.append(h('button', {
        class: 'btn small danger', type: 'button', text: '清除',
        onclick: async () => {
          if (!(await confirmBox('清除令牌', name === 'adminToken' ? '清除后保存，将无法再登录管理页面（需要手工编辑配置文件恢复）。确定？' : '清除后保存，MCP HTTP 接口将拒绝所有请求。确定？', '清除', 'danger'))) return;
          setIn(S.draft, path, undefined);
          changed();
          draw();
        },
      }));
    }
    const children = [row];
    if (shown) children.push(h('input', { type: 'text', readOnly: true, value: shown, class: 'mono', style: 'margin-top:8px', onfocus: (e) => e.target.select() }));
    put(box, ...children);
  };
  void value;
  draw();
  return box;
}

async function pickAgentKey(path, ctx) {
  const pamPath = path.slice(0, 2);
  const socket = getIn(S.draft, [...pamPath, 'agentSocket']) || '';
  let res;
  try {
    res = await api('GET', `/agent/keys${socket ? `?socket=${encodeURIComponent(socket)}` : ''}`);
  } catch (e) {
    toast(`读取 SSH Agent 失败：${e.message}`, 'error', 8000);
    return;
  }
  const current = getIn(S.draft, path);
  const body = h('div', {},
    h('div', { class: 'help', style: 'margin:0 0 10px' }, rich(`来自 \`${res.socket.path}\`（${res.socket.source}）。只读取公钥，不会触发签名或 1Password 授权。`)),
    res.keys.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: '标题 / 注释' }), h('th', { text: '类型' }), h('th', { text: '指纹' }), h('th', {}))),
      h('tbody', {}, res.keys.map((k) => h('tr', {},
        h('td', { text: k.comment || '（无）' }),
        h('td', { text: k.type }),
        h('td', { class: 'mono', text: k.fingerprint }),
        h('td', {}, current === k.fingerprint ? h('span', { class: 'badge ok', text: '当前' }) : h('button', {
          class: 'btn small primary', type: 'button', text: '使用',
          onclick: () => { setIn(S.draft, path, k.fingerprint); document.querySelector('.modal-back')?.remove(); changed({ structural: true }); },
        })))))))
      : h('div', { class: 'empty' }, rich('agent 中没有密钥。在 1Password：设置 → 开发者 → 启用“使用 SSH 代理”，并把密钥放在允许的保管库中。')));
  void ctx;
  modal({ title: '选择登录密钥', body, wide: true, actions: [{ label: '关闭', value: true }] });
}

// ---------- login-string preview ----------
function renderUsername(template, vars) {
  return template.replace(/\{([A-Za-z]+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : `⟨未知占位符 ${k}⟩`));
}
const PAM_DEFAULT_TEMPLATE = () => S.meta.fields.pamFields.find((f) => f.key === 'usernameTemplate').default;
function loginOf(targetId, t = S.draft.targets?.[targetId]) {
  if (!t) return null;
  const pamIds = Object.keys(S.draft.pamServers || {});
  const pamId = t.pam ?? (pamIds.length === 1 ? pamIds[0] : undefined);
  const pam = pamId ? S.draft.pamServers[pamId] : undefined;
  if (!pam) return { error: pamId ? `PAM 服务器 "${pamId}" 不存在` : '请选择 PAM 服务器' };
  const username = t.username ?? renderUsername(pam.usernameTemplate ?? PAM_DEFAULT_TEMPLATE(), {
    pamUser: pam.user ?? '⟨PAM账号⟩', account: t.account ?? '⟨目标账号⟩', host: t.host ?? '⟨目标主机⟩', pamHost: pam.host ?? '⟨网关⟩', target: targetId,
  });
  const port = pam.port ?? 22;
  return { pamId, username, ssh: `ssh ${username}@${pam.host ?? '⟨网关⟩'}${port !== 22 ? ` -p ${port}` : ''}` };
}
let previewUpdaters = [];
function refreshPreviews() { for (const fn of previewUpdaters) fn(); }

// ---------- pages ----------
function pageHead(title, desc, actions = []) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', { text: title }), desc ? h('p', {}, rich(desc)) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}
function card(title, body, { actions = [], help } = {}) {
  return h('section', { class: 'card' },
    title ? h('div', { class: 'card-head' }, h('h2', { text: title }), actions.length ? h('div', { class: 'actions' }, actions) : null) : null,
    h('div', { class: 'card-body' }, help ? h('div', { class: 'card-help' }, rich(help)) : null, body));
}

function overview() {
  previewUpdaters = [];
  const body = h('div', {}, h('div', { class: 'empty', text: '加载状态…' }));
  mainEl.append(pageHead('概览', '服务运行状态与配置健康度。'), body);
  const load = async () => {
    let st;
    try { st = await api('GET', '/status'); } catch (e) { put(body, h('div', { class: 'msg error', text: e.message })); return; }
    const c = st.counts;
    const warnings = dirty() ? S.v.warnings : st.warnings;
    const agentStat = st.agent.reachable
      ? h('span', {}, h('span', { class: 'dot ok' }), ` 可用，${st.agent.keys} 把密钥`)
      : h('span', {}, h('span', { class: 'dot err' }), ' 无法连接');
    const cmd = `claude mcp add --transport http pamssh ${st.mcpUrl} --header "Authorization: Bearer $(pamssh-mcp token)"`;
    put(body, 
      st.restartRequired.length ? h('div', { class: 'banner warn' }, `配置中的 ${st.restartRequired.map((r) => `${r.path.join('.')}（运行中：${r.running} → 配置：${r.configured}）`).join('、')} 需要重启服务才能生效。`) : null,
      st.envOverrides.length ? h('div', { class: 'banner info' }, `以下配置由环境变量覆盖：${st.envOverrides.map((o) => `${o.name} → ${o.path.join('.')}`).join('、')}`) : null,
      h('div', { class: 'grid', style: 'margin-bottom:16px' },
        statCard('目标', c.targets, `PAM 服务器 ${c.pamServers} 个`, () => go('targets')),
        statCard('SSH 会话', `${c.activeSessions} / ${c.sessions}`, c.staleSessions ? `${c.staleSessions} 个使用旧配置` : '活动 / 全部', () => go('sessions')),
        statCard('MCP 客户端', c.mcpClients, `管理会话 ${c.adminSessions} 个`),
        statCard('运行时长', uptime(st.uptimeSec), `pid ${st.pid} · Node ${st.node}`)),
      card('服务', h('dl', { class: 'kv' },
        h('dt', { text: 'MCP 地址' }), h('dd', { class: 'mono', text: st.mcpUrl }),
        h('dt', { text: '配置文件' }), h('dd', { class: 'mono', text: st.configFile }),
        h('dt', { text: '配置版本' }), h('dd', { class: 'mono', text: st.configVersion }),
        h('dt', { text: '日志级别' }), h('dd', { text: st.logLevel }),
        h('dt', { text: 'SSH Agent' }), h('dd', {}, agentStat, h('div', { class: 'mono', style: 'color:var(--muted)', text: `${st.agent.path}（${st.agent.source}）` }),
          st.agent.error ? h('div', { class: 'msg error', text: st.agent.error }) : null))),
      card('接入 agent', h('div', {},
        h('div', { class: 'preview', text: cmd }),
        h('div', { class: 'btn-row', style: 'margin-top:8px' }, h('button', { class: 'btn small', type: 'button', text: '复制命令', onclick: () => copy(cmd) }))),
      { help: 'Claude Code 中执行以下命令接入（令牌通过 `pamssh-mcp token` 读取，不会出现在命令历史中）。其他客户端：Streamable HTTP，请求头 `Authorization: Bearer <MCP 令牌>`。' }),
      card(`配置检查（${warnings.length}）`, warnings.length
        ? h('div', { style: 'display:grid;gap:6px' }, warnings.map((w) => h('div', { class: `msg ${w.level === 'warn' ? 'warn' : 'info'}` },
          h('button', { class: 'linkish', type: 'button', text: w.path.join('.') || '（全局）', onclick: () => goToPath(w.path) }), '：', rich(w.message))))
        : h('div', { class: 'msg ok', text: '没有发现问题。' }),
      { help: dirty() ? '基于当前未保存的草稿。' : '基于已保存的配置。' }),
    );
  };
  load();
  S.timers.push(setInterval(load, 10000));
}
function statCard(label, value, sub, onClick) {
  return h('div', { class: 'card stat', style: onClick ? 'cursor:pointer' : '', onclick: onClick },
    h('div', { class: 'label', text: label }), h('div', { class: 'value', text: String(value) }), h('div', { class: 'sub', text: sub }));
}

// targets
function targets() {
  previewUpdaters = [];
  const ts = S.draft.targets || {};
  const ids = Object.keys(ts);
  if (S.sel.target && !ts[S.sel.target]) S.sel.target = null;
  if (!S.sel.target && ids.length) S.sel.target = ids[0];
  writeHash();
  const filter = h('input', { type: 'search', placeholder: '搜索 ID / 主机 / 账号 / 标签', value: S.targetFilter || '' });
  const list = h('div', { class: 'list' });
  const drawList = () => {
    const q = (S.targetFilter || '').toLowerCase();
    const shown = ids.filter((id) => !q || `${id} ${ts[id].host} ${ts[id].account} ${(ts[id].tags || []).join(' ')} ${ts[id].description || ''}`.toLowerCase().includes(q));
    put(list, ...(shown.length ? shown.map((id) => h('button', {
      class: `item ${S.sel.target === id ? 'active' : ''}`, type: 'button', onclick: () => { S.sel.target = id; render(); },
    },
    h('div', { class: 'id' }, h('span', { class: 'dot ok', 'data-dot': pathKey(['targets', id]) }), id),
    h('div', { class: 'sub', text: `${ts[id].account ?? '?'}@${ts[id].host ?? '?'}${ts[id].pam ? ` · ${ts[id].pam}` : ''}` }),
    (ts[id].tags || []).length ? h('div', { class: 'chips' }, ts[id].tags.map((t) => h('span', { class: 'chip', text: t }))) : null))
      : [h('div', { class: 'empty', text: ids.length ? '没有匹配的目标' : '还没有目标' })]));
    refreshListDots();
  };
  filter.addEventListener('input', () => { S.targetFilter = filter.value; drawList(); });
  drawList();
  const addBtn = h('button', { class: 'btn primary small', type: 'button', text: '新建目标', onclick: addTarget });
  const left = h('div', { class: 'list-pane' }, card(`目标（${ids.length}）`, h('div', {}, h('div', { style: 'padding:4px 4px 8px' }, filter), list), { actions: [addBtn] }));
  const right = h('div', {});
  if (!S.sel.target) {
    right.append(card(null, h('div', { class: 'empty' }, '还没有目标。目标 = 通过某个 PAM 网关、以某个账号登录的某台服务器。', h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary', type: 'button', text: '新建目标', onclick: addTarget })))));
  } else {
    const id = S.sel.target;
    const base = ['targets', id];
    const preview = h('div', { class: 'preview' });
    const upd = () => {
      const l = loginOf(id);
      put(preview, h('div', { class: 'label', text: '等价的终端登录命令' }), l?.error ? h('span', { style: 'color:var(--danger)', text: l.error }) : (l?.ssh ?? ''));
    };
    upd();
    previewUpdaters.push(upd);
    right.append(
      pageHead(id, ts[id].description || '', [
        h('button', { class: 'btn small', type: 'button', text: '复制为新目标', onclick: () => duplicateTarget(id) }),
        h('button', { class: 'btn small', type: 'button', text: '重命名', onclick: () => renameTarget(id) }),
        h('button', { class: 'btn small danger', type: 'button', text: '删除', onclick: () => deleteTarget(id) }),
      ]),
      h('div', { style: 'margin-bottom:16px' }, preview),
      card('目标设置', h('div', { 'data-path': pathKey(base) }, h('div', { class: 'fissues' }), renderFields(S.meta.fields.targetFields, base))),
      policyTester(id),
      connectionTester(id),
    );
  }
  mainEl.append(pageHead('目标', '每个目标是 agent 可以执行命令的一台服务器（通过 PAM 网关、以指定账号登录）。agent 通过 ID 选择目标。'),
    h('div', { class: 'split' }, left, right));
}

async function addTarget() {
  const ids = Object.keys(S.draft.targets || {});
  const id = await promptId('新建目标', S.meta.fields.idHelp, '', ids);
  if (!id) return;
  S.draft.targets = S.draft.targets || {};
  const pamIds = Object.keys(S.draft.pamServers || {});
  S.draft.targets[id] = pamIds.length > 1 ? { pam: pamIds[0] } : {};
  S.sel.target = id;
  S.tab = 'targets';
  changed({ structural: true });
}
async function duplicateTarget(id) {
  const ids = Object.keys(S.draft.targets);
  const nid = await promptId('复制为新目标', `复制目标 “${id}” 的全部设置。${S.meta.fields.idHelp}`, `${id}-copy`, ids);
  if (!nid) return;
  S.draft.targets[nid] = clone(S.draft.targets[id]);
  S.sel.target = nid;
  changed({ structural: true });
}
async function renameTarget(id) {
  const ids = Object.keys(S.draft.targets).filter((x) => x !== id);
  const nid = await promptId('重命名目标', `agent 通过 ID 选择目标，改名后 agent 需要使用新 ID；已有会话会在保存后关闭。${S.meta.fields.idHelp}`, id, ids);
  if (!nid || nid === id) return;
  S.draft.targets = renameKey(S.draft.targets, id, nid);
  S.sel.target = nid;
  changed({ structural: true });
}
async function deleteTarget(id) {
  if (!(await confirmBox('删除目标', `删除目标 “${id}”？保存后它的 SSH 会话会被关闭，agent 将无法再使用它。`, '删除', 'danger'))) return;
  delete S.draft.targets[id];
  S.sel.target = null;
  changed({ structural: true });
}

function policyTester(targetId) {
  const input = h('input', { type: 'text', placeholder: '输入一条命令，例如 rm -rf /var/log', spellcheck: 'false' });
  const out = h('div', { class: 'fissues', style: 'display:grid' });
  const run = async () => {
    put(out);
    if (!input.value.trim()) return;
    try {
      const r = await api('POST', '/policy/test', { raw: S.draft, target: targetId, command: input.value });
      if (r.allowed) {
        out.append(h('div', { class: 'msg ok' }, '允许执行。', r.matched.length ? ` 命中允许规则：${r.matched.map((m) => `${m.layer} /${m.rule}/`).join('；')}` : ' （没有允许规则限制，也没有命中拒绝规则）'));
      } else if (r.kind === 'deny') {
        out.append(h('div', { class: 'msg error' }, `拒绝：命中${r.decidedBy}的拒绝规则 `, h('code', { text: `/${r.rule}/` })));
      } else {
        out.append(h('div', { class: 'msg error', text: `拒绝：${r.decidedBy}设置了允许规则，但命令没有匹配任何一条。` }));
      }
    } catch (e) {
      out.append(h('div', { class: 'msg error', text: e.message }));
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  return card('策略测试', h('div', {}, h('div', { class: 'inline-row' }, input, h('button', { class: 'btn', type: 'button', text: '测试', onclick: run })), out),
    { help: '用当前草稿（包括未保存的修改）检查一条命令会不会被全局策略和此目标的策略放行。不会连接服务器。' });
}

function connectionTester(targetId) {
  const out = h('div', {});
  const btn = h('button', {
    class: 'btn', type: 'button', text: '测试连接',
    onclick: async () => {
      const savedT = S.saved.targets?.[targetId];
      if (!savedT) { toast('目标还没有保存，先保存再测试', 'warn'); return; }
      const note = dirty() ? '\n\n注意：测试使用的是已保存的配置，不包含未保存的修改。' : '';
      if (!(await confirmBox('测试连接', `将通过 PAM 网关真实登录 “${targetId}”（可能弹出 1Password 授权），执行 \`id; hostname; pwd\` 后立即退出。此操作会出现在 PAM 审计和录像中。${note}`, '开始测试'))) return;
      btn.disabled = true;
      put(out, h('div', { class: 'msg info', text: '正在登录…如果 1Password 弹出授权请求，请批准。' }));
      try {
        const r = await api('POST', '/targets/test', { target: targetId });
        put(out, r.ok
          ? h('div', {}, h('div', { class: 'msg ok', text: `登录成功（${(r.durationMs / 1000).toFixed(1)} 秒）：${r.login}，网关指纹 ${r.hostKey ?? '—'}` }),
            r.note ? h('div', { class: 'msg warn', text: `命令未执行：${r.note}` }) : null,
            r.output ? h('pre', { class: 'out', text: r.output }) : null)
          : h('div', { class: 'msg error', text: `失败（${(r.durationMs / 1000).toFixed(1)} 秒）：${r.error}` }));
      } catch (e) {
        put(out, h('div', { class: 'msg error', text: e.message }));
      } finally {
        btn.disabled = false;
      }
    },
  });
  return card('连接测试', h('div', {}, btn, out), { help: '使用已保存的配置真实登录一次，检查密钥、PAM 授权和登录串格式是否正确。' });
}

// PAM servers
function pams() {
  previewUpdaters = [];
  const ps = S.draft.pamServers || {};
  const ids = Object.keys(ps);
  if (S.sel.pam && !ps[S.sel.pam]) S.sel.pam = null;
  if (!S.sel.pam && ids.length) S.sel.pam = ids[0];
  writeHash();
  const addBtn = h('button', { class: 'btn primary small', type: 'button', text: '新建', onclick: addPam });
  const list = h('div', { class: 'list' }, ids.length ? ids.map((id) => h('button', {
    class: `item ${S.sel.pam === id ? 'active' : ''}`, type: 'button', onclick: () => { S.sel.pam = id; render(); },
  },
  h('div', { class: 'id' }, h('span', { class: 'dot ok', 'data-dot': pathKey(['pamServers', id]) }), id),
  h('div', { class: 'sub', text: `${ps[id].user ?? '?'} → ${ps[id].host ?? '?'}:${ps[id].port ?? 22}` }))) : h('div', { class: 'empty', text: '还没有 PAM 服务器' }));
  const left = h('div', { class: 'list-pane' }, card(`PAM 服务器（${ids.length}）`, list, { actions: [addBtn] }));
  const right = h('div', {});
  if (S.sel.pam) {
    const id = S.sel.pam;
    const base = ['pamServers', id];
    const usedBy = Object.keys(S.draft.targets || {}).filter((t) => loginOf(t)?.pamId === id);
    const usage = h('div', {});
    const upd = () => {
      const tpl = ps[id]?.usernameTemplate ?? PAM_DEFAULT_TEMPLATE();
      const sample = renderUsername(tpl, { pamUser: ps[id]?.user ?? '⟨PAM账号⟩', account: 'root', host: '10.0.0.11', pamHost: ps[id]?.host ?? '⟨网关⟩', target: 'web-01' });
      put(usage, 
        h('div', { class: 'preview', style: 'margin-bottom:10px' }, h('div', { class: 'label', text: '模板示例（目标账号 root、主机 10.0.0.11）' }), `ssh ${sample}@${ps[id]?.host ?? '⟨网关⟩'}`),
        usedBy.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', { text: '使用它的目标' }), h('th', { text: '登录命令' }))),
          h('tbody', {}, usedBy.map((t) => h('tr', {},
            h('td', {}, h('button', { class: 'linkish', type: 'button', text: t, onclick: () => go('targets', t) })),
            h('td', { class: 'mono', text: loginOf(t)?.ssh ?? '' }))))))
          : h('div', { class: 'msg info', text: '还没有目标使用这个 PAM 服务器。' }));
    };
    upd();
    previewUpdaters.push(upd);
    right.append(
      pageHead(id, '', [
        h('button', { class: 'btn small', type: 'button', text: '重命名', onclick: () => renamePam(id) }),
        h('button', { class: 'btn small danger', type: 'button', text: '删除', onclick: () => deletePam(id, usedBy) }),
      ]),
      card('网关设置', h('div', { 'data-path': pathKey(base) }, h('div', { class: 'fissues' }), renderFields(S.meta.fields.pamFields, base, {
        groupExtra: {},
      }))),
      card('主机指纹', hostKeyScanner(id), { help: '读取网关当前的 SSH 主机指纹（只做握手，不登录、不签名），可以一键固定到上面的“固定网关指纹”。' }),
      card('登录串预览', usage),
    );
  } else {
    right.append(card(null, h('div', { class: 'empty' }, '先添加一个 PAM 服务器（堡垒机 / 网关）。', h('div', { style: 'margin-top:12px' }, addBtn.cloneNode(true)))));
    right.querySelector('.empty .btn')?.addEventListener('click', addPam);
  }
  mainEl.append(pageHead('PAM 服务器', 'PAM 网关（堡垒机）的地址、你的 PAM 个人账号、登录串格式，以及从 1Password 选哪把密钥登录。'),
    h('div', { class: 'split' }, left, right));
}

function hostKeyScanner(pamId) {
  const out = h('div', {});
  const btn = h('button', {
    class: 'btn', type: 'button', text: '获取主机指纹',
    onclick: async () => {
      const p = S.draft.pamServers[pamId];
      if (!p?.host) { toast('先填写网关地址', 'warn'); return; }
      btn.disabled = true;
      put(out, h('div', { class: 'msg info', text: `正在连接 ${p.host}:${p.port ?? 22}…` }));
      try {
        const r = await api('POST', '/hostkeys/scan', { host: p.host, port: p.port ?? 22 });
        const pinned = [].concat(p.hostFingerprint ?? []);
        const isPinned = pinned.map((x) => x.replace(/=+$/, '')).includes(r.fingerprint);
        const isRecorded = r.recorded.includes(r.fingerprint);
        put(out, 
          h('dl', { class: 'kv' },
            h('dt', { text: '指纹' }), h('dd', { class: 'mono', text: r.fingerprint }),
            h('dt', { text: '密钥类型' }), h('dd', { text: r.type }),
            h('dt', { text: '服务端标识' }), h('dd', { class: 'mono', text: r.banner ?? '—' }),
            h('dt', { text: '状态' }), h('dd', {},
              isPinned ? h('span', { class: 'badge ok', text: '已固定' })
                : pinned.length ? h('span', { class: 'badge err', text: '与已固定的指纹不一致！' }) : h('span', { class: 'badge', text: '未固定' }),
              ' ',
              r.recorded.length ? (isRecorded ? h('span', { class: 'badge ok', text: '与首次连接记录一致' }) : h('span', { class: 'badge err', text: '与首次连接记录不一致！' })) : h('span', { class: 'badge', text: '尚无首次连接记录' }))),
          (!isPinned) ? h('div', { class: 'btn-row', style: 'margin-top:10px' }, h('button', {
            class: 'btn primary small', type: 'button', text: '固定为此指纹',
            onclick: () => {
              const next = [...pinned, r.fingerprint];
              setIn(S.draft, ['pamServers', pamId, 'hostFingerprint'], next.length === 1 ? next[0] : next);
              changed({ structural: true });
              toast('已加入草稿，保存后生效', 'ok');
            },
          })) : null,
          h('div', { class: 'help' }, rich('请通过可信渠道（例如 PAM 管理员、在网关上执行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`）核对指纹后再固定。')));
      } catch (e) {
        put(out, h('div', { class: 'msg error', text: e.message }));
      } finally {
        btn.disabled = false;
      }
    },
  });
  return h('div', {}, btn, out);
}

async function addPam() {
  const ids = Object.keys(S.draft.pamServers || {});
  const id = await promptId('新建 PAM 服务器', `给这个网关起一个 ID，例如 pam-prod。${S.meta.fields.idHelp}`, ids.length ? '' : 'pam-prod', ids);
  if (!id) return;
  S.draft.pamServers = S.draft.pamServers || {};
  S.draft.pamServers[id] = {};
  S.sel.pam = id;
  S.tab = 'pams';
  changed({ structural: true });
}
async function renamePam(id) {
  const ids = Object.keys(S.draft.pamServers).filter((x) => x !== id);
  const nid = await promptId('重命名 PAM 服务器', `引用它的目标会一并更新。${S.meta.fields.idHelp}`, id, ids);
  if (!nid || nid === id) return;
  S.draft.pamServers = renameKey(S.draft.pamServers, id, nid);
  for (const t of Object.values(S.draft.targets || {})) if (t.pam === id) t.pam = nid;
  S.sel.pam = nid;
  changed({ structural: true });
}
async function deletePam(id, usedBy) {
  const explicit = Object.entries(S.draft.targets || {}).filter(([, t]) => t.pam === id).map(([t]) => t);
  if (usedBy.length && Object.keys(S.draft.pamServers).length === 1) {
    await modal({ title: '无法删除', body: h('div', {}, `这是唯一的 PAM 服务器，以下目标正在使用：${usedBy.join('、')}。先删除这些目标或添加其他 PAM 服务器。`), actions: [{ label: '知道了', value: true }] });
    return;
  }
  if (explicit.length) {
    await modal({ title: '无法删除', body: h('div', {}, `以下目标正在使用它：${explicit.join('、')}。先把这些目标改到其他 PAM 服务器或删除它们。`), actions: [{ label: '知道了', value: true }] });
    return;
  }
  if (!(await confirmBox('删除 PAM 服务器', `删除 “${id}”？`, '删除', 'danger'))) return;
  delete S.draft.pamServers[id];
  S.sel.pam = null;
  changed({ structural: true });
}

// global settings
function settings() {
  previewUpdaters = [];
  mainEl.append(pageHead('全局设置', '作用于整个服务和所有目标的设置。每个字段下方有说明、默认值和示例；留空即使用默认值。'));
  for (const sec of S.meta.fields.globalSections) {
    const body = h('div', { 'data-path': pathKey(sec.path) }, renderFields(sec.fields, sec.path));
    const extra = sec.id === 'policy' ? globalPolicyTester() : null;
    mainEl.append(card(sec.title, h('div', {}, body, extra), { help: sec.help }));
  }
}
function globalPolicyTester() {
  const input = h('input', { type: 'text', placeholder: '输入一条命令测试全局策略', spellcheck: 'false' });
  const out = h('div', { class: 'fissues', style: 'display:grid' });
  const run = async () => {
    put(out);
    if (!input.value.trim()) return;
    try {
      const r = await api('POST', '/policy/test', { raw: S.draft, command: input.value });
      out.append(r.allowed
        ? h('div', { class: 'msg ok', text: '全局策略允许（目标自己的策略还会再检查一次）。' })
        : h('div', { class: 'msg error' }, r.kind === 'deny' ? ['拒绝：命中拒绝规则 ', h('code', { text: `/${r.rule}/` })] : '拒绝：没有匹配任何允许规则。'));
    } catch (e) {
      out.append(h('div', { class: 'msg error', text: e.message }));
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  return h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', { text: '测试命令' })),
    h('div', { class: 'inline-row' }, input, h('button', { class: 'btn', type: 'button', text: '测试', onclick: run })), out);
}

// sessions
function sessions() {
  const body = h('div', {}, h('div', { class: 'empty', text: '加载中…' }));
  mainEl.append(pageHead('SSH 会话', '本服务当前保持的 PAM 登录。所有 agent 共享这些会话；每 5 秒刷新。'), card(null, body));
  const load = async () => {
    let r;
    try { r = await api('GET', '/sessions'); } catch (e) { put(body, h('div', { class: 'msg error', text: e.message })); return; }
    if (!r.sessions.length) { put(body, h('div', { class: 'empty', text: '当前没有 SSH 会话。agent 第一次调用 pam_exec 时会自动登录。' })); return; }
    const stateBadge = (s) => ({ ready: h('span', { class: 'badge ok', text: '已连接' }), connecting: h('span', { class: 'badge', text: '连接中' }), error: h('span', { class: 'badge err', text: '错误' }), disconnected: h('span', { class: 'badge', text: '已断开' }), new: h('span', { class: 'badge', text: '未连接' }) }[s.state] || h('span', { class: 'badge', text: s.state }));
    put(body, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['目标 / 会话', '状态', '来源', '登录串', '当前目录', '命令数', '最后活动', '空闲超时', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, r.sessions.map((s) => {
        const idleLeft = s.idleTimeoutMinutes > 0 && s.state === 'ready'
          ? Math.max(0, Math.round(s.idleTimeoutMinutes - (Date.now() - new Date(s.lastUsedAt).getTime()) / 60000)) : null;
        return h('tr', {},
          h('td', {}, h('button', { class: 'linkish', type: 'button', text: s.target, onclick: () => go('targets', s.target) }), ` / ${s.session}`),
          h('td', {}, stateBadge(s), s.busy ? h('span', { class: 'badge', text: '执行中' }) : null, s.stale ? h('span', { class: 'badge stale', text: '使用旧配置', title: '连接参数已在配置中修改，关闭后按新配置重连' }) : null,
            s.lastError ? h('div', { class: 'msg error', style: 'margin-top:4px', text: s.lastError }) : null),
          h('td', { text: ORIGIN_LABEL[s.origin] || s.origin || '—', title: s.active ? '占用会话名额' : '不占用名额（失败或已断开）' }),
          h('td', { class: 'mono', text: s.login }),
          h('td', { class: 'mono', text: s.cwd ?? '—' }),
          h('td', { text: s.commands }),
          h('td', { text: ago(s.lastUsedAt), title: fmtTime(s.lastUsedAt) }),
          h('td', { text: s.idleTimeoutMinutes === 0 ? '永不' : idleLeft === null ? `${s.idleTimeoutMinutes} 分钟` : `约 ${idleLeft} 分钟后` }),
          h('td', {}, h('div', { class: 'btn-row' }, h('button', {
            class: 'btn small', type: 'button', text: '打开终端',
            onclick: () => { S.term.target = s.target; S.term.session = s.session; go('shell'); termOpen(s.target, s.session); },
          }), h('button', {
            class: 'btn small danger', type: 'button', text: '关闭',
            onclick: async () => {
              if (!(await confirmBox('关闭会话', `关闭 ${s.target}/${s.session}？正在执行的命令会被中断，cwd 和环境变量会丢失；agent 下次调用会自动重新登录。`, '关闭', 'danger'))) return;
              await api('POST', '/sessions/close', { target: s.target, session: s.session });
              toast('已关闭', 'ok');
              load();
            },
          }))));
      })))));
  };
  load();
  S.timers.push(setInterval(load, 5000));
}

// audit
function audit() {
  const targetSel = h('select', {}, h('option', { value: '', text: '全部目标' }), Object.keys(S.saved.targets || {}).map((t) => h('option', { value: t, text: t })));
  const eventSel = h('select', {}, [['', '全部事件'], ['exec', '执行'], ['result', '结果'], ['denied', '被策略拒绝'], ['error', '错误']].map(([v, t]) => h('option', { value: v, text: t })));
  const q = h('input', { type: 'search', placeholder: '搜索命令 / 客户端…' });
  const limit = h('select', {}, [100, 200, 500, 1000].map((n) => h('option', { value: n, text: `最近 ${n} 条`, selected: n === 200 })));
  const body = h('div', {});
  const info = h('div', { class: 'card-help' });
  const load = async () => {
    const qs = new URLSearchParams({ limit: limit.value, target: targetSel.value, event: eventSel.value, q: q.value });
    let r;
    try { r = await api('GET', `/audit?${qs}`); } catch (e) { put(body, h('div', { class: 'msg error', text: e.message })); return; }
    const days = S.saved.audit?.retentionDays ?? 30;
    put(info, rich(`文件：\`${r.file}\`${r.enabled ? '' : '（审计已关闭，不会写入新记录）'}。不记录命令输出。${days === 0 ? '记录永久保留。' : `保留最近 ${days} 天，服务启动时和每 6 小时自动清理更早的记录。`}`));
    if (!r.entries.length) { put(body, h('div', { class: 'empty', text: '没有记录' })); return; }
    const ev = { exec: ['执行', 'badge'], result: ['结果', 'badge ok'], denied: ['拒绝', 'badge err'], error: ['错误', 'badge err'] };
    put(body, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['时间', '事件', '目标 / 会话', '命令 / 结果', '来源'].map((t) => h('th', { text: t })))),
      h('tbody', {}, r.entries.map((e) => h('tr', { class: e.event === 'denied' ? 'denied' : '' },
        h('td', { text: fmtTime(e.ts) }),
        h('td', {}, h('span', { class: (ev[e.event] || ['', 'badge'])[1], text: (ev[e.event] || [e.event])[0] })),
        h('td', { text: `${e.target}/${e.session}` }),
        h('td', { class: 'mono' }, e.command ?? (e.event === 'result'
          ? `exit=${e.exitCode} · ${e.durationMs}ms · ${e.outputChars} 字符${e.timedOut ? ' · 超时' : ''}${e.interrupted ? ' · 手动中断' : ''}${e.sessionEnded ? ' · 会话结束' : ''}` : ''),
        e.reason ? h('div', { style: 'color:var(--danger)', text: e.reason }) : null,
        e.error ? h('div', { style: 'color:var(--danger)', text: e.error }) : null),
        h('td', { text: [e.actor?.client === 'admin-ui' ? '管理页面' : e.actor?.client, e.actor?.mcpSession?.slice(0, 8)].filter(Boolean).join(' · ') || '—' })))))));
  };
  for (const el of [targetSel, eventSel, limit]) el.addEventListener('change', load);
  let qt;
  q.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(load, 300); });
  mainEl.append(pageHead('审计日志', 'agent 请求执行的每条命令（最新在前）。'),
    card(null, h('div', {}, info, h('div', { class: 'filters' }, targetSel, eventSel, q, limit,
      h('button', { class: 'btn small', type: 'button', text: '刷新', onclick: load }),
      h('button', {
        class: 'btn small', type: 'button', text: '立即清理过期记录',
        onclick: async () => {
          const days = S.saved.audit?.retentionDays ?? 30;
          if (days === 0) { toast('保留天数为 0（永久保留），不会清理', 'warn'); return; }
          if (!(await confirmBox('清理审计记录', `删除 ${days} 天以前的审计记录？删除后无法恢复。`, '清理', 'danger'))) return;
          try {
            const r = await api('POST', '/audit/prune');
            toast(r.removed ? `已删除 ${r.removed} 条过期记录，保留 ${r.kept} 条` : '没有过期记录', 'ok');
            load();
          } catch (err) { toast(err.message, 'error'); }
        },
      })), body)));
  load();
}

// host keys
function hostkeys() {
  const body = h('div', {});
  const load = async () => {
    let r;
    try { r = await api('GET', '/hostkeys'); } catch (e) { put(body, h('div', { class: 'msg error', text: e.message })); return; }
    const known = Object.entries(r.known);
    put(body, 
      card('首次连接时记录的指纹', known.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['网关', '指纹', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, known.map(([hostId, fps]) => h('tr', {},
          h('td', { class: 'mono', text: hostId }),
          h('td', { class: 'mono', text: fps.join('\n') }),
          h('td', {}, h('button', {
            class: 'btn small danger', type: 'button', text: '删除记录',
            onclick: async () => {
              if (!(await confirmBox('删除指纹记录', `删除 ${hostId} 的记录？下次连接时会重新记录当时的指纹（如果开启了“首次连接时信任”）。只在确认网关更换了主机密钥时这样做。`, '删除', 'danger'))) return;
              await api('POST', '/hostkeys/delete', { hostId });
              toast('已删除', 'ok');
              load();
            },
          }))))))) : h('div', { class: 'empty', text: '还没有记录' }),
      { help: `文件：\`${r.file}\` · 首次连接时信任：${r.trustOnFirstUse ? '开启' : '关闭'}。网关指纹变化时连接会被拒绝；确认是正常更换后，删除对应记录或在 PAM 服务器上固定新指纹。` }),
      card('配置中固定的指纹', h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['PAM 服务器', '网关', '固定的指纹'].map((t) => h('th', { text: t })))),
        h('tbody', {}, r.pinned.map((p) => h('tr', {},
          h('td', {}, h('button', { class: 'linkish', type: 'button', text: p.pam, onclick: () => go('pams', p.pam) })),
          h('td', { class: 'mono', text: p.hostId }),
          h('td', { class: 'mono', text: p.fingerprints.length ? p.fingerprints.join('\n') : '（未固定）' })))))),
      { help: '固定的指纹优先于首次连接记录。在 PAM 服务器页面可以读取并固定当前指纹。' }),
    );
  };
  mainEl.append(pageHead('主机指纹', 'PAM 网关的 SSH 主机指纹校验，防止中间人攻击。'), body);
  load();
}

// logs
function logs() {
  const levelSel = h('select', {}, [['', '全部级别'], ['error', '仅错误'], ['warn', '警告及以上'], ['info', 'info 及以上']].map(([v, t]) => h('option', { value: v, text: t })));
  const q = h('input', { type: 'search', placeholder: '过滤…' });
  const follow = h('input', { type: 'checkbox', checked: true, id: 'log-follow' });
  const box = h('div', { class: 'logbox' });
  const entries = [];
  let after = 0;
  const rank = { error: 0, warn: 1, info: 2, debug: 3 };
  const draw = () => {
    const max = levelSel.value ? rank[levelSel.value] : 9;
    const needle = q.value.toLowerCase();
    put(box, ...entries
      .filter((e) => rank[e.level] <= max && (!needle || e.msg.toLowerCase().includes(needle)))
      .map((e) => h('div', { class: `log-${e.level}` }, `${new Date(e.ts).toLocaleTimeString()} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`)));
    if (follow.checked) box.scrollTop = box.scrollHeight;
  };
  const load = async () => {
    try {
      const r = await api('GET', `/logs?after=${after}`);
      if (r.entries.length) {
        entries.push(...r.entries);
        after = r.entries.at(-1).seq;
        if (entries.length > 1000) entries.splice(0, entries.length - 1000);
        draw();
      }
      cur.textContent = `当前日志级别：${r.level}（可在“全局设置 → SSH Agent 与日志”中修改）`;
    } catch { /* shown elsewhere */ }
  };
  const cur = h('span', { class: 'card-help' });
  levelSel.addEventListener('change', draw);
  q.addEventListener('input', draw);
  mainEl.append(pageHead('服务日志', '本进程最近 1000 条日志，每 2 秒刷新。登录过程、1Password 授权请求、错误都会出现在这里。'),
    card(null, h('div', {}, cur, h('div', { class: 'filters' }, levelSel, q, h('label', { for: 'log-follow' }, follow, ' 自动滚动')), box)));
  load();
  S.timers.push(setInterval(load, 2000));
}

// raw JSON
function json() {
  const ta = h('textarea', { rows: 30, spellcheck: 'false', style: 'max-width:none' });
  ta.value = JSON.stringify(S.draft, null, 2);
  const out = h('div', { class: 'fissues', style: 'display:grid' });
  const parse = () => {
    put(out);
    try { return JSON.parse(ta.value); } catch (e) { out.append(h('div', { class: 'msg error', text: `JSON 语法错误：${e.message}` })); return null; }
  };
  mainEl.append(pageHead('配置文件', '直接编辑完整配置（JSON）。适合批量修改或粘贴配置；应用到草稿后仍需在底部“保存并应用”。'),
    card(null, h('div', {},
      h('div', { class: 'card-help' }, rich(`令牌显示为 \`${MASK()}\`，表示保持原值不变；要更换令牌，直接替换成新值。文件：\`${S.meta.configFile}\``)),
      h('div', { class: 'btn-row', style: 'margin-bottom:8px' },
        h('button', { class: 'btn small', type: 'button', text: '格式化', onclick: () => { const v = parse(); if (v) ta.value = JSON.stringify(v, null, 2); } }),
        h('button', {
          class: 'btn small', type: 'button', text: '校验',
          onclick: async () => {
            const v = parse();
            if (!v) return;
            const r = await api('POST', '/config/validate', { raw: v });
            put(out, ...(r.ok ? [h('div', { class: 'msg ok', text: `校验通过${r.warnings.length ? `，${r.warnings.length} 条建议` : ''}` })] : []),
              ...r.issues.map((i) => h('div', { class: 'msg error' }, h('code', { text: i.path.join('.') || '（根）' }), ' ', i.message)),
              ...r.warnings.map((w) => h('div', { class: `msg ${w.level === 'warn' ? 'warn' : 'info'}` }, h('code', { text: w.path.join('.') }), ' ', w.message)));
          },
        }),
        h('button', {
          class: 'btn small primary', type: 'button', text: '应用到草稿',
          onclick: async () => {
            const v = parse();
            if (!v) return;
            if (!v || typeof v !== 'object' || Array.isArray(v)) { out.append(h('div', { class: 'msg error', text: '顶层必须是对象' })); return; }
            S.draft = v;
            await validateNow();
            render();
            toast(S.v.ok ? '已应用到草稿，确认无误后点击底部“保存并应用”。' : `已应用到草稿，但有 ${S.v.issues.length} 个错误需要修正。`, S.v.ok ? 'ok' : 'warn');
          },
        }),
        h('button', { class: 'btn small', type: 'button', text: '从草稿刷新', onclick: () => { ta.value = JSON.stringify(S.draft, null, 2); put(out); } })),
      ta, out)));
}

// backups
function backups() {
  const body = h('div', {});
  const load = async () => {
    let r;
    try { r = await api('GET', '/backups'); } catch (e) { put(body, h('div', { class: 'msg error', text: e.message })); return; }
    if (!r.backups.length) { put(body, h('div', { class: 'empty', text: '还没有备份。每次保存前会自动备份旧配置（保留最近 30 份）。' })); return; }
    put(body, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['备份时间', '大小', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, r.backups.map((b) => h('tr', {},
        h('td', { text: fmtTime(b.mtime), title: b.name }),
        h('td', { text: `${(b.size / 1024).toFixed(1)} KB` }),
        h('td', {}, h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn small', type: 'button', text: '查看',
            onclick: async () => {
              const { raw } = await api('GET', `/backup?name=${encodeURIComponent(b.name)}`);
              const changes = diffPaths(raw, S.saved);
              modal({
                title: `备份 ${fmtTime(b.mtime)}`, wide: true,
                body: h('div', {},
                  h('div', { class: 'card-help', text: `与当前已保存配置相比有 ${changes.length} 处不同：${changes.slice(0, 12).map((c) => c.path.join('.')).join('、')}${changes.length > 12 ? '…' : ''}` }),
                  h('pre', { class: 'out', text: JSON.stringify(raw, null, 2) })),
                actions: [{ label: '关闭', value: true }],
              });
            },
          }),
          h('button', {
            class: 'btn small', type: 'button', text: '恢复',
            onclick: async () => {
              const warn = dirty() ? '当前有未保存的修改，恢复后会丢失。' : '';
              if (!(await confirmBox('恢复备份', `${warn}用这份备份替换当前配置并立即应用？当前配置会先自动备份。`, '恢复', 'danger'))) return;
              try {
                const res = await api('POST', '/backup/restore', { name: b.name, baseVersion: S.version });
                const cfg = await api('GET', '/config');
                S.saved = cfg.raw; S.draft = clone(cfg.raw); S.version = cfg.version;
                S.restartNotice = res.applied.restartRequired;
                await validateNow();
                render();
                toast('已恢复并应用', 'ok');
              } catch (e) {
                toast(`恢复失败：${e.message}`, 'error', 8000);
              }
            },
          })))))))));
  };
  mainEl.append(pageHead('备份', '每次通过管理页面保存前，旧配置会自动备份到配置文件旁的 backups 目录（保留最近 30 份，权限 600）。'),
    card(null, body), card('从磁盘重新加载', h('div', { class: 'btn-row' }, h('button', {
      class: 'btn', type: 'button', text: '重新加载配置文件',
      onclick: async () => {
        if (dirty() && !(await confirmBox('重新加载', '有未保存的修改，重新加载后会丢失。继续？', '重新加载', 'danger'))) return;
        try {
          const r = await api('POST', '/config/reload');
          const cfg = await api('GET', '/config');
          S.saved = cfg.raw; S.draft = clone(cfg.raw); S.version = cfg.version;
          if (r.applied) S.restartNotice = r.applied.restartRequired;
          await validateNow();
          render();
          toast(r.changed ? '已从磁盘重新加载并应用' : '配置文件没有变化', 'ok');
        } catch (e) {
          toast(`重新加载失败：${e.message}`, 'error', 10000);
        }
      },
    })), { help: '手工编辑了配置文件后，用它让运行中的服务应用新配置（无需重启）。文件有错误时不会应用，并显示错误。' }));
  load();
}

// ---------- shell (terminal-like command runner) ----------
const ORIGIN_LABEL = { agent: 'agent', 'admin-ui': '管理页面', cli: 'CLI' };
const TERM_MAX_CHARS = 2 * 1024 * 1024;
S.term = {
  target: null,
  session: null,
  screens: {},
  history: store.get('shellHistory', []),
  timeoutMs: '',
  sessionsCache: [],
};
const termKey = (t, s) => `${t}#${s}`;
function screenOf(key) {
  if (!S.term.screens[key]) S.term.screens[key] = { entries: [], cwd: null, running: null, ended: false, chars: 0 };
  return S.term.screens[key];
}
function collapseCR(text) {
  if (!text.includes('\r')) return text;
  return text.split('\n').map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r');
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') return parts[i];
    return '';
  }).join('\n');
}
function termPrompt(target, cwd) {
  const acct = S.saved.targets?.[target]?.account ?? '?';
  return `${acct}@${target}:${cwd || '~'}$ `;
}
function termPush(key, entry) {
  const sc = screenOf(key);
  sc.entries.push(entry);
  sc.chars += (entry.text || '').length;
  while (sc.chars > TERM_MAX_CHARS && sc.entries.length > 1) sc.chars -= (sc.entries.shift().text || '').length;
  const out = document.getElementById('term-out');
  if (out && out.dataset.key === key) {
    out.append(termEntryEl(entry));
    out.scrollTop = out.scrollHeight;
  }
  return entry;
}
/** Output as a terminal shows it: \r overwrites, and the final newline does not add an empty line. */
const entryText = (e) => (e.kind === 'out' ? collapseCR(e.text).replace(/\n$/, '') : e.text);
function termEntryEl(e) {
  if (e.kind === 'cmd') {
    const el = h('div', { class: 't-cmd' }, h('span', { class: 't-prompt', text: e.prompt }), h('span', { class: 't-cmdtext', text: e.text }));
    e.el = el;
    return el;
  }
  const el = h('div', { class: e.cls || '', text: entryText(e) });
  e.el = el;
  return el;
}
function termUpdate(key, entry) {
  const out = document.getElementById('term-out');
  if (entry.el && out && out.dataset.key === key) {
    entry.el.textContent = entryText(entry);
    out.scrollTop = out.scrollHeight;
  }
}
function addHistory(cmd) {
  const hist = S.term.history.filter((x) => x !== cmd);
  hist.push(cmd);
  S.term.history = hist.slice(-200);
  store.set('shellHistory', S.term.history);
}

async function termLoadSessions() {
  try {
    S.term.sessionsCache = (await api('GET', '/sessions')).sessions;
  } catch { /* shown elsewhere */ }
  return S.term.sessionsCache;
}

async function termOpen(target, name) {
  const key = termKey(target, name);
  const sc = screenOf(key);
  S.term.target = target;
  S.term.session = name;
  sc.ended = false;
  const note = termPush(key, { kind: 'meta', cls: 't-meta', text: `正在打开会话 ${target}/${name}…（新登录可能弹出 1Password 授权，请批准）` });
  render();
  try {
    const r = await api('POST', '/shell/open', { target, session: name });
    note.text = `已连接 ${r.session.login}${r.session.hostKey ? `（网关指纹 ${r.session.hostKey}）` : ''}`;
    termUpdate(key, note);
    if (r.session.cwd) sc.cwd = r.session.cwd;
    if (r.session.origin === 'agent') {
      termPush(key, { kind: 'meta', cls: 't-warn', text: '注意：这个会话是 agent 打开的，在这里执行的 cd / export 等会改变 agent 看到的状态。' });
    }
    if (!sc.cwd) await termRun(target, name, 'pwd', { silent: true });
  } catch (e) {
    note.text = `打开失败：${e.message}`;
    note.cls = 't-err';
    if (note.el) note.el.className = 't-err';
    termUpdate(key, note);
    sc.ended = true;
  }
  await termLoadSessions();
  render();
}

/** Run one command and stream its output into the screen. */
async function termRun(target, name, command, { silent = false } = {}) {
  const key = termKey(target, name);
  const sc = screenOf(key);
  if (sc.running) return;
  const controller = new AbortController();
  sc.running = { command, started: Date.now(), controller, silent };
  if (!silent) termPush(key, { kind: 'cmd', prompt: termPrompt(target, sc.cwd), text: command });
  const out = silent ? { text: '' } : termPush(key, { kind: 'out', text: '' });
  renderTermControls();
  let result = null;
  let failure = null;
  try {
    const res = await fetch('/admin/api/shell/exec', {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-pamssh-admin': '1' },
      body: JSON.stringify({ target, session: name, command, timeoutMs: S.term.timeoutMs ? Number(S.term.timeoutMs) : undefined }),
    });
    if (res.status === 401) { showLogin('登录已过期，请重新登录'); throw new Error('未登录'); }
    if (!res.ok) {
      let j = null;
      try { j = await res.json(); } catch { /* not json */ }
      throw new Error(j?.error || `${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'output' && !silent) { out.text += ev.data; termUpdate(key, out); }
        else if (ev.type === 'output-capped' && !silent) termPush(key, { kind: 'meta', cls: 't-warn', text: `…实时输出超过 ${ev.limit} 字符，后续只显示最终结果` });
        else if (ev.type === 'result') result = ev;
        else if (ev.type === 'error') failure = ev;
      }
    }
  } catch (e) {
    failure = { message: e.name === 'AbortError' ? '已取消' : e.message };
  } finally {
    sc.running = null;
  }
  if (result) {
    if (result.cwd) sc.cwd = result.cwd;
    if (!silent) {
      out.text = result.output; // final output: truncated and cleaned the same way agents see it
      if (!out.text) { out.el?.remove(); sc.entries.splice(sc.entries.indexOf(out), 1); } else termUpdate(key, out);
      const meta = [];
      if (result.reconnected) meta.push(['t-warn', '会话已重新登录：之前的当前目录和环境变量已丢失']);
      if (result.interrupted) meta.push(['t-warn', `^C 已中断（exit ${result.exitCode}）`]);
      else if (result.timedOut) meta.push(['t-warn', `超时，已发送 Ctrl-C（exit ${result.exitCode}）`]);
      else if (result.exitCode !== 0 && result.exitCode !== null) meta.push(['t-err', `exit ${result.exitCode}`]);
      if (result.truncated) meta.push(['t-meta', '输出过长，中间部分已截断（与 agent 看到的一致）']);
      if (result.durationMs >= 3000) meta.push(['t-meta', `耗时 ${humanMs(result.durationMs)}`]);
      if (result.stderr) termPush(key, { kind: 'out', text: result.stderr, cls: 't-err' });
      for (const [cls, text] of meta) termPush(key, { kind: 'meta', cls, text });
    }
    if (result.sessionEnded) {
      sc.ended = true;
      termPush(key, { kind: 'meta', cls: 't-warn', text: '会话已结束（远端 shell 已退出）。再次执行命令会重新登录。' });
    }
  } else if (failure) {
    if (!silent && !out.text) { out.el?.remove(); sc.entries.splice(sc.entries.indexOf(out), 1); }
    termPush(key, { kind: 'meta', cls: 't-err', text: failure.policy ? `被策略拒绝：${failure.message.replace(/^blocked by policy: /, '')}（可在“目标”页修改策略）` : `错误：${failure.message}` });
  }
  renderTermControls();
}

async function termInterrupt() {
  const { target, session } = S.term;
  if (!target || !session) return;
  try {
    const r = await api('POST', '/shell/interrupt', { target, session });
    if (!r.ok) toast('当前没有正在运行的命令', 'warn', 2500);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function termEndSession() {
  const { target, session } = S.term;
  if (!target || !session) return;
  const sc = screenOf(termKey(target, session));
  const busy = sc.running ? '正在运行的命令会被中断，' : '';
  if (!(await confirmBox('结束会话', `结束 ${target}/${session}？${busy}远端 shell 会退出，PAM 登录被释放。`, '结束会话', 'danger'))) return;
  try {
    await api('POST', '/sessions/close', { target, session });
    sc.ended = true;
    sc.cwd = null;
    termPush(termKey(target, session), { kind: 'meta', cls: 't-warn', text: '会话已结束（手动）。' });
    toast('会话已结束', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
  await termLoadSessions();
  render();
}

let termControlsEl = null;
document.addEventListener('keydown', (e) => {
  if (S.tab !== 'shell' || !e.ctrlKey || (e.key !== 'c' && e.key !== 'C')) return;
  const { target, session } = S.term;
  const sc = target && session ? S.term.screens[termKey(target, session)] : null;
  if (!sc?.running || sc.running.silent || window.getSelection()?.toString()) return;
  e.preventDefault();
  termInterrupt();
});
function renderTermControls() {
  if (!termControlsEl || !document.body.contains(termControlsEl)) return;
  const { target, session } = S.term;
  const sc = target && session ? screenOf(termKey(target, session)) : null;
  if (!sc) { put(termControlsEl); return; }
  if (sc.running && !sc.running.silent) {
    const secs = () => Math.round((Date.now() - sc.running.started) / 1000);
    const label = h('span', { text: `运行中 ${secs()} 秒` });
    put(termControlsEl, h('div', { class: 'term-run' },
      h('span', { class: 'spin' }), label,
      h('button', { class: 'btn small', type: 'button', text: '中断 (Ctrl-C)', onclick: termInterrupt }),
      h('span', { style: 'color:var(--t-dim)', text: '命令运行期间按 Ctrl-C 也可中断' })));
    const t = setInterval(() => { if (!sc.running) clearInterval(t); else label.textContent = `运行中 ${secs()} 秒`; }, 1000);
    S.timers.push(t);
    return;
  }
  const prompt = h('span', { class: 't-prompt', text: termPrompt(target, sc.cwd) });
  const ta = h('textarea', { rows: 1, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': '命令输入' });
  let histIdx = S.term.history.length;
  let draft = '';
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`; };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const cmd = ta.value.replace(/\s+$/, '');
      if (!cmd.trim()) { termPush(termKey(target, session), { kind: 'cmd', prompt: termPrompt(target, sc.cwd), text: '' }); return; }
      addHistory(cmd);
      if (cmd.trim() === 'clear') { termClear(); return; }
      termRun(target, session, cmd).then(() => document.querySelector('.term-in textarea')?.focus());
    } else if (e.key === 'ArrowUp' && !before.includes('\n') && S.term.history.length) {
      e.preventDefault();
      if (histIdx === S.term.history.length) draft = ta.value;
      histIdx = Math.max(0, histIdx - 1);
      ta.value = S.term.history[histIdx];
      grow();
    } else if (e.key === 'ArrowDown' && !after.includes('\n') && histIdx < S.term.history.length) {
      e.preventDefault();
      histIdx += 1;
      ta.value = histIdx === S.term.history.length ? draft : S.term.history[histIdx];
      grow();
    } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault();
      termPush(termKey(target, session), { kind: 'cmd', prompt: termPrompt(target, sc.cwd), text: `${ta.value}^C` });
      ta.value = '';
      grow();
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      termClear();
    }
  });
  put(termControlsEl, h('div', { class: 'term-in' }, prompt, ta));
  requestAnimationFrame(() => ta.focus({ preventScroll: true }));
}
function termClear() {
  const { target, session } = S.term;
  const sc = screenOf(termKey(target, session));
  sc.entries = [];
  sc.chars = 0;
  const out = document.getElementById('term-out');
  if (out) put(out);
}

function shell() {
  const targetIds = Object.keys(S.saved.targets || {});
  if (S.term.target && !targetIds.includes(S.term.target)) { S.term.target = null; S.term.session = null; }
  const targetSel = h('select', { 'aria-label': '目标' },
    h('option', { value: '', text: targetIds.length ? '选择目标…' : '（没有目标）' }),
    targetIds.map((t) => h('option', { value: t, text: `${t}（${S.saved.targets[t].account}@${S.saved.targets[t].host}）`, selected: t === S.term.target })));
  const sessionSel = h('select', { 'aria-label': '会话' });
  const fillSessions = () => {
    const t = targetSel.value;
    const list = S.term.sessionsCache.filter((x) => x.target === t);
    put(sessionSel,
      h('option', { value: '__new__', text: '＋ 新建会话…' }),
      list.map((x) => h('option', {
        value: x.session,
        selected: x.session === S.term.session && t === S.term.target,
        text: `${x.session} · ${({ ready: '已连接', connecting: '连接中', error: '失败', disconnected: '已断开', new: '未连接' })[x.state] || x.state} · ${ORIGIN_LABEL[x.origin] || x.origin}${x.busy ? ' · 执行中' : ''}`,
      })));
    if (!list.some((x) => x.session === S.term.session && t === S.term.target)) {
      sessionSel.value = list.find((x) => x.origin === 'admin-ui')?.session ?? '__new__';
    }
  };
  targetSel.addEventListener('change', fillSessions);
  const openBtn = h('button', {
    class: 'btn primary', type: 'button', text: '打开',
    onclick: async () => {
      const t = targetSel.value;
      if (!t) { toast('先选择目标', 'warn'); return; }
      let name = sessionSel.value;
      if (name === '__new__') {
        const used = S.term.sessionsCache.filter((x) => x.target === t).map((x) => x.session);
        let n = 1;
        while (used.includes(`ui-${n}`)) n++;
        name = await promptSessionName(`ui-${n}`, used);
        if (!name) return;
      }
      termOpen(t, name);
    },
  });
  const timeoutSel = h('select', { 'aria-label': '命令超时', onchange: (e) => { S.term.timeoutMs = e.target.value; } },
    [['', '超时：目标默认'], ['30000', '超时：30 秒'], ['120000', '超时：2 分钟'], ['600000', '超时：10 分钟'], ['1800000', '超时：30 分钟'], ['3600000', '超时：60 分钟']]
      .map(([v, t]) => h('option', { value: v, text: t, selected: S.term.timeoutMs === v })));

  const { target, session } = S.term;
  const key = target && session ? termKey(target, session) : null;
  const sc = key ? screenOf(key) : null;
  const info = h('div', { class: 'term-info' });
  if (key) {
    const st = S.term.sessionsCache.find((x) => x.target === target && x.session === session);
    info.append(
      h('span', {}, '当前：', h('span', { class: 'mono', text: `${target}/${session}` })),
      st ? h('span', {}, '状态：', h('span', { class: 'mono', text: st.state })) : h('span', { text: '状态：未打开' }),
      st?.login ? h('span', {}, '登录：', h('span', { class: 'mono', text: st.login })) : null,
      st ? h('span', {}, '来源：', ORIGIN_LABEL[st.origin] || st.origin) : null,
      sc.cwd ? h('span', {}, '目录：', h('span', { class: 'mono', text: sc.cwd })) : null,
    );
  }
  const toolbar = card(null, h('div', {},
    h('div', { class: 'term-bar' }, targetSel, sessionSel, openBtn, timeoutSel,
      h('span', { class: 'grow', style: 'flex:1' }),
      key ? h('button', { class: 'btn small', type: 'button', text: '清屏 (Ctrl-L)', onclick: termClear }) : null,
      key ? h('button', { class: 'btn small danger', type: 'button', text: '结束会话', onclick: termEndSession }) : null),
    info));

  const outEl = h('div', { class: 'term-out', id: 'term-out', 'data-key': key || '' });
  if (sc) {
    outEl.append(h('div', { class: 't-banner', text: `${target}/${session} · 每条命令都经过命令策略检查并记入审计 · stdin 为 /dev/null，不支持 vim、top、less 等交互程序` }));
    for (const e of sc.entries) outEl.append(termEntryEl(e));
  } else {
    outEl.append(h('div', { class: 'term-empty' },
      targetIds.length ? '选择目标和会话后点“打开”。会话可以是新建的（独立 PAM 登录），也可以是已有的（例如 agent 正在用的 default）。' : '还没有目标，先在“目标”页添加。'));
  }
  outEl.addEventListener('mouseup', () => {
    if (!window.getSelection()?.toString()) document.querySelector('.term-in textarea')?.focus({ preventScroll: true });
  });
  termControlsEl = h('div', {});
  const termEl = h('div', { class: 'term' }, outEl, termControlsEl);

  mainEl.append(
    pageHead('终端', '以终端方式在目标上执行命令：选择目标，新建或接入一个会话，逐条执行并实时查看输出。命令在会话里按顺序执行，cd 和环境变量会保留。'),
    toolbar, termEl,
    h('div', { class: 'help', style: 'margin-top:8px' }, rich('`Enter` 执行 · `Shift+Enter` 换行 · `↑`/`↓` 历史命令 · `Ctrl-C` 中断正在运行的命令 · `Ctrl-L` 清屏。输出过长时会和 agent 看到的一样截断中间部分；需要完整内容时用 grep / head / tail 过滤。')));
  termLoadSessions().then(() => { fillSessions(); });
  fillSessions();
  renderTermControls();
  requestAnimationFrame(() => { outEl.scrollTop = outEl.scrollHeight; });
}

async function promptSessionName(initial, used) {
  const re = /^[A-Za-z0-9._-]{1,32}$/;
  const input = h('input', { type: 'text', value: initial, spellcheck: 'false' });
  const err = h('div', { class: 'fissues' });
  let value = null;
  const ok = await modal({
    title: '新建会话',
    body: h('div', {},
      h('div', { class: 'help', style: 'margin:0 0 8px' }, rich('每个会话是一次独立的 PAM 登录（可能弹出 1Password 授权），计入目标的会话上限。会话名只能包含字母、数字、点、下划线和连字符。')),
      input, err),
    actions: [{ label: '取消', value: false }, {
      label: '创建并登录', kind: 'primary', value: true,
      onClick: () => {
        const v = input.value.trim();
        put(err);
        if (!re.test(v)) { err.append(h('div', { class: 'msg error', text: '名称无效' })); return false; }
        if (used.includes(v)) { err.append(h('div', { class: 'msg error', text: '已存在同名会话，请在会话列表中直接选择它' })); return false; }
        value = v;
        return true;
      },
    }],
  });
  return ok ? value : null;
}

boot();
