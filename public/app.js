'use strict';

/* 课栈前端：课程浏览 + 分集播放 + 跨设备进度同步
 * 进度按「课程 + 分集」为粒度记录，key 形如 math-01#12
 * 多 P 合集以集为单位累计，避免总时长失真。
 */

const API_BASE = location.protocol === 'file:' ? '' : location.origin;
const IS_STATIC = location.protocol === 'file:';
const LS_CODE = 'kezhan.code';
const LS_TOKEN = 'kezhan.token';
const LS_SUBJECT = 'kezhan.subject';
const LS_PROGRESS = 'kezhan.progress.cache';
const FALLBACK_DURATION = 600;

const state = {
  courses: [],
  meta: {},
  progress: {},
  filters: { grade: 'all', subject: 'math', status: 'all', sort: 'score', q: '' },
  code: null,
  online: false,
  syncing: false,
  player: { course: null, ep: 0, pos: 0, duration: FALLBACK_DURATION, timer: null, dirty: false, lastInteract: 0, ticking: false, loadTimer: null },
  lastSyncAt: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(r)}` : `${pad2(m)}:${pad2(r)}`;
};
const fmtMinutes = (sec) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
};
const fmtShort = (sec) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`;
};
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function setSync(kind, text) {
  const dot = $('syncDot');
  if (dot) dot.className = 'dot' + (kind ? ' ' + kind : '');
  const tx = $('syncText');
  if (tx) tx.textContent = text;
}

/* ---------------- 数据加载 ---------------- */

async function loadCourses() {
  const res = await fetch('./data/courses.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('课程数据加载失败');
  const data = await res.json();
  // 失效视频（源站删除/不可见）自动隐藏，避免点开是空播放器
  const all = data.courses || [];
  const dead = all.filter((c) => c.dead);
  state.courses = all.filter((c) => !c.dead);
  state.meta = data;
  const eps = state.courses.reduce((s, c) => s + (c.partCount || 1), 0);
  $('dataNote').textContent =
    `${state.courses.length} 门课程 · ${eps} 个分集 · 核对于 ${data.generatedAt}` +
    (dead.length ? ` · 已隐藏 ${dead.length} 门失效课程` : '');
  // 默认学科用上次选过的，没有则取课程库第一个学科，避免写死 math
  const keys = (data.subjects || []).map((s) => s.key);
  const last = localStorage.getItem(LS_SUBJECT);
  state.filters.subject = last && keys.includes(last) ? last : (keys[0] || 'math');
}

/* ---------------- 进度读写 ---------------- */

const epKey = (courseId, ep) => courseId + '#' + ep;

function epRec(courseId, ep) {
  return state.progress[epKey(courseId, ep)] || null;
}

function epDuration(c, ep) {
  const r = epRec(c.id, ep);
  if (r && r.duration > 0) return r.duration;
  const p = c.parts && c.parts[ep];
  if (p && p.d > 0) return p.d;
  return c.episodeDuration || FALLBACK_DURATION;
}

function courseById(id) {
  return state.courses.find((c) => c.id === id) || null;
}

/** 去掉 B 站标题里自带的「1.」「P1」「第1集」前缀，避免与本集序号重复 */
function cleanEpTitle(raw) {
  let t = String(raw || '').trim();
  // 上游分集标题形如「集合】1集合的概念」，开头的「【」被吞掉了，
  // 留下孤立闭合括号，套进《》会显示成「《集合】…》」。这里按「章节】正文」拆开，
  // 只取正文（章节名在下方的分集条里已有上下文）。
  const orphan = t.indexOf('】');
  if (orphan > 0 && t.indexOf('【') === -1) t = t.slice(orphan + 1);
  t = t.replace(/^[】）)\]]+\s*/, '');
  t = t.replace(/^[（(\[]?\s*(?:[Pp]\s*\d+|[第]\s*\d+\s*[集课讲节]?|\d+)\s*[）)\].、:：\-—]?\s*/, '');
  return t.trim() || String(raw || '').trim();
}

/** 课程级聚合：按「集」的平均完成度计算，合集不会被总时长稀释 */
function courseStats(c) {
  const n = c.partCount || 1;
  let watched = 0;
  let doneEps = 0;
  let startedEps = 0;
  let lastAt = 0;
  let lastEp = -1;
  let fracSum = 0;
  for (let i = 0; i < n; i++) {
    const r = epRec(c.id, i);
    if (!r) continue;
    watched += r.watched || 0;
    if (r.watched > 0) startedEps += 1;
    if (r.done) { doneEps += 1; fracSum += 1; } else if (r.watched > 0) {
      const d = r.duration > 0 ? r.duration : epDuration(c, i);
      fracSum += Math.min(0.99, r.watched / d);
    }
    const t = new Date(r.updatedAt || 0).getTime();
    if ((r.watched || 0) > 0 && t >= lastAt) { lastAt = t; lastEp = i; }
  }
  const total = c.totalDuration || (c.episodeDuration || FALLBACK_DURATION) * n;
  const done = doneEps === n;
  const pct = done ? 100 : Math.min(99.9, Math.round((fracSum / n) * 1000) / 10);
  return {
    watched, doneEps, startedEps, lastAt, lastEp, total, pct,
    done, status: done ? 'done' : (watched > 0 ? 'doing' : 'todo'), partCount: n,
  };
}

function readLocalProgress() {
  try { return JSON.parse(localStorage.getItem(LS_PROGRESS) || '{}') || {}; } catch (_) { return {}; }
}

let lsTimer = null;
let lsDirty = false;
function writeLocalProgress(immediate) {
  lsDirty = true;
  if (immediate) {
    clearTimeout(lsTimer);
    lsTimer = null;
    lsDirty = false;
    try { localStorage.setItem(LS_PROGRESS, JSON.stringify(state.progress)); } catch (_) { /* 隐私模式忽略 */ }
    return;
  }
  if (lsTimer) return;
  lsTimer = setTimeout(() => {
    lsTimer = null;
    if (!lsDirty) return;
    lsDirty = false;
    try { localStorage.setItem(LS_PROGRESS, JSON.stringify(state.progress)); } catch (_) { /* 忽略 */ }
  }, 4000);
}

/* ---------------- 服务端同步 ---------------- */

async function api(path, options) {
  if (!API_BASE) throw new Error('offline');
  const headers = { 'Content-Type': 'application/json' };
  const token = (localStorage.getItem(LS_TOKEN) || '').trim();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API_BASE + path, Object.assign({ headers }, options));
  if (!res.ok) {
    const err = new Error('http_' + res.status);
    err.status = res.status;
    try { err.payload = await res.json(); } catch (_) { /* ignore */ }
    throw err;
  }
  return res.json();
}

async function ensureHousehold() {
  const saved = (localStorage.getItem(LS_CODE) || '').trim();
  if (saved) {
    try {
      const data = await api('/api/household?code=' + encodeURIComponent(saved));
      return data.household;
    } catch (err) {
      if (err.status === 404) localStorage.removeItem(LS_CODE);
      else throw err;
    }
  }
  const created = await api('/api/household', { method: 'POST', body: '{}' });
  localStorage.setItem(LS_CODE, created.household.code);
  return created.household;
}

async function connect() {
  if (IS_STATIC) {
    state.online = false;
    state.code = null;
    $('codeText').textContent = '本地';
    $('codeBtn').disabled = true;
    $('codeBtn').title = '当前以本地文件方式打开，未连接同步服务';
    state.progress = readLocalProgress();
    setSync('warn', '本地模式');
    return;
  }
  try {
    setSync('', '连接中');
    const household = await ensureHousehold();
    state.code = household.code;
    state.progress = household.progress || {};
    state.online = true;
    state.lastSyncAt = household.updatedAt;
    $('codeText').textContent = household.code;
    writeLocalProgress();
    setSync('ok', '进度已同步');
  } catch (err) {
    if (err.status === 401) return handleAuthRequired();
    state.online = false;
    state.code = localStorage.getItem(LS_CODE) || null;
    state.progress = readLocalProgress();
    $('codeText').textContent = state.code || '离线';
    setSync('bad', '离线（本地暂存）');
  }
}

/** 服务端启用了访问令牌（AUTH_TOKEN）时引导输入一次，存在本机后续自动带上 */
async function handleAuthRequired() {
  state.online = false;
  state.code = localStorage.getItem(LS_CODE) || null;
  state.progress = readLocalProgress();
  setSync('bad', '需要访问令牌');
  $('codeText').textContent = '未授权';
  const input = window.prompt('这台服务器启用了访问令牌（AUTH_TOKEN），请粘贴后回车：', '');
  if (input === null) return;
  const token = input.trim();
  if (!token) return;
  localStorage.setItem(LS_TOKEN, token);
  await connect();
  render();
}

let pushTimer = null;
let pushPending = false;
let lastFlushAt = 0;
const dirtyKeys = new Set();
const PUSH_CHUNK = 60;
const PUSH_INTERVAL = 15000; // 观看期间的强制同步间隔

function markDirty(key) {
  dirtyKeys.add(key);
}

/** 已排定的上传不被打断：避免每秒 persist 把定时器无限延后 */
function queuePush(delay = 800) {
  pushPending = true;
  const idle = Date.now() - lastFlushAt;
  if ($('statSave') && idle > 2000) $('statSave').textContent = '待上传';
  if (pushTimer) return;
  const since = Date.now() - lastFlushAt;
  const wait = Math.max(200, Math.min(delay, PUSH_INTERVAL - since));
  pushTimer = setTimeout(() => { pushTimer = null; flushPush(); }, wait);
}

async function flushPush() {
  if (!dirtyKeys.size) { pushPending = false; return; }
  writeLocalProgress();
  if (!state.online || !state.code) {
    pushPending = false;
    if ($('statSave')) $('statSave').textContent = '仅本地';
    return;
  }
  const keys = Array.from(dirtyKeys).filter((k) => state.progress[k]);
  if (!keys.length) { dirtyKeys.clear(); pushPending = false; return; }
  try {
    state.syncing = true;
    setSync('', '同步中');
    let last = null;
    // 分批上传，避免单请求过大；失败时保留剩余 key 重试
    for (let i = 0; i < keys.length; i += PUSH_CHUNK) {
      const chunk = keys.slice(i, i + PUSH_CHUNK);
      const updates = chunk.map((k) => state.progress[k]);
      const res = await api('/api/progress?code=' + encodeURIComponent(state.code), {
        method: 'PUT',
        body: JSON.stringify({ updates }),
      });
      last = res;
      // 服务端返回的是合并后的权威值：只回填本批，避免覆盖本地更新中的其它集
      const merged = res.progress || {};
      chunk.forEach((k) => {
        if (merged[k]) state.progress[k] = merged[k];
        dirtyKeys.delete(k);
      });
    }
    state.lastSyncAt = last ? last.updatedAt : state.lastSyncAt;
    pushPending = false;
    lastFlushAt = Date.now();
    writeLocalProgress();
    setSync('ok', '进度已同步');
    if ($('statSave')) $('statSave').textContent = '已同步 ' + fmtDate(state.lastSyncAt).split(' ')[1];
    render();
  } catch (err) {
    lastFlushAt = Date.now();
    setSync('bad', '同步失败，将重试');
    if ($('statSave')) $('statSave').textContent = '待重试';
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    setTimeout(flushPush, 6000);
  } finally {
    state.syncing = false;
  }
}

window.addEventListener('online', () => { if (!state.online) connect().then(render); });
window.addEventListener('offline', () => setSync('warn', '网络已断开'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    writeLocalProgress(true);
    flushPush();
  }
});
window.addEventListener('beforeunload', () => {
  writeLocalProgress(true);
  if (dirtyKeys.size && navigator.sendBeacon && state.online && state.code) {
    const updates = Array.from(dirtyKeys).map((k) => state.progress[k]).filter(Boolean).slice(0, 60);
    // 用 fetch keepalive 代替 sendBeacon：sendBeacon 不能带请求头，
    // 只能把令牌塞进 URL，而 URL 会被 Nginx/容器原样写进访问日志。
    // keepalive 既能在页面卸载后继续发出，又能保持 Authorization 头，不落痕。
    const headers = { 'Content-Type': 'application/json' };
    const token = (localStorage.getItem(LS_TOKEN) || '').trim();
    if (token) headers.Authorization = 'Bearer ' + token;
    try {
      fetch(API_BASE + '/api/progress?code=' + encodeURIComponent(state.code), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ updates }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* 页面正在卸载，忽略 */ }
  }
});

/* ---------------- 筛选 ---------------- */

function buildFilters() {
  const grades = ['all'].concat(state.meta.grades || []);
  const gc = $('gradeChips');
  gc.innerHTML = '';
  grades.forEach((g) => {
    const b = el('button', 'chip' + (state.filters.grade === g ? ' on' : ''), g === 'all' ? '全部年级' : g);
    b.type = 'button';
    b.dataset.grade = g;
    gc.appendChild(b);
  });

  const sc = $('subjectChips');
  sc.innerHTML = '';
  (state.meta.subjects || []).forEach((s) => {
    const b = el('button', 'chip' + (state.filters.subject === s.key ? ' on' : ''), `${s.name} ${s.count}`);
    b.type = 'button';
    b.dataset.subject = s.key;
    sc.appendChild(b);
  });
}

function bindChipGroups() {
  $('gradeChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-grade]');
    if (!b) return;
    state.filters.grade = b.dataset.grade;
    syncChips('#gradeChips', 'grade', b.dataset.grade);
    render();
  });
  $('subjectChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-subject]');
    if (!b) return;
    state.filters.subject = b.dataset.subject;
    try { localStorage.setItem(LS_SUBJECT, b.dataset.subject); } catch (_) { /* 隐私模式忽略 */ }
    syncChips('#subjectChips', 'subject', b.dataset.subject);
    render();
  });
  $('stateChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-state]');
    if (!b) return;
    state.filters.status = b.dataset.state;
    syncChips('#stateChips', 'state', b.dataset.state);
    render();
  });
  $('sortChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    state.filters.sort = b.dataset.sort;
    syncChips('#sortChips', 'sort', b.dataset.sort);
    render();
  });
  $('q').addEventListener('input', (e) => {
    state.filters.q = e.target.value.trim().toLowerCase();
    render();
  });
}

function syncChips(sel, attr, value) {
  document.querySelectorAll(sel + ' [data-' + attr + ']').forEach((b) => {
    b.classList.toggle('on', b.dataset[attr] === value);
  });
}

/* ---------------- 渲染 ---------------- */

const COVER_COLORS = [
  'linear-gradient(135deg,#58B2DC,#86C166)',
  'linear-gradient(135deg,#B481BB,#F7587C)',
  'linear-gradient(135deg,#00AA90,#58B2DC)',
  'linear-gradient(135deg,#FFB11B,#F17C67)',
  'linear-gradient(135deg,#B9887D,#FFB11B)',
  'linear-gradient(135deg,#86C166,#00AA90)',
];

function filtered() {
  const f = state.filters;
  const list = state.courses.filter((c) => {
    if (f.subject !== 'all' && c.subject !== f.subject) return false;
    if (f.grade !== 'all' && c.grade !== f.grade) return false;
    if (f.status !== 'all' && courseStats(c).status !== f.status) return false;
    if (f.q) {
      const hay = (c.title + ' ' + c.creator + ' ' + c.topic + ' ' + (c.tags || []).join(' ') + ' ' + c.subjectName).toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
  if (f.sort === 'score') list.sort((a, b) => b.score - a.score);
  if (f.sort === 'play') list.sort((a, b) => b.play - a.play);
  if (f.sort === 'mine') {
    list.sort((a, b) => (courseStats(b).lastAt - courseStats(a).lastAt) || (b.score - a.score));
  }
  return list;
}

function cardFor(course, idx) {
  const st = courseStats(course);
  const card = el('article', 'card');
  card.dataset.id = course.id;

  const cover = el('div', 'cover');
  cover.style.background = COVER_COLORS[idx % COVER_COLORS.length];
  // 真实封面（B 站 CDN 缩图）；加载失败时 img 移除，露出下面的渐变色块和文字
  if (course.cover) {
    const img = el('img', 'cover-img');
    img.src = course.cover;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove(), { once: true });
    cover.appendChild(img);
  }
  cover.append(
    el('span', 'sub', course.subjectName + ' · ' + course.grade),
    el('span', 'tagm', course.partCount > 1 ? course.partCount + ' 集' : fmtShort(course.episodeDuration)),
    el('span', 'tagm', course.playText + ' 播放')
  );

  const name = el('div', 'name', course.title);
  name.title = course.title;

  const reason = el('div', 'reason', course.reason || (course.subjectName + ' · ' + course.topic));
  reason.title = course.reason || '';

  const src = el('div', 'src');
  src.append(el('b', null, course.creator), document.createTextNode(' · ' + course.topic));

  const pbar = el('div', 'pbar');
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = st.pct + '%';
  if (st.done) fill.style.background = 'var(--success)';
  bar.appendChild(fill);
  let label;
  if (st.done) label = el('span', 'badge-done', '已完成');
  else if (st.watched > 0) label = el('span', null, `已看 ${st.startedEps}/${st.partCount} 集`);
  else label = el('span', null, '未开始');
  pbar.append(bar, label);

  const btn = el('button', 'playbtn');
  btn.type = 'button';
  btn.dataset.play = course.id;
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l12 7-12 7z"/></svg>' +
    (st.done ? '再看一遍' : (st.watched > 0 ? '继续播放' : '开始学习'));

  card.append(cover, name, reason, src, pbar, btn);
  return card;
}

function renderResume() {
  let best = null;
  state.courses.forEach((c) => {
    const st = courseStats(c);
    if (st.status === 'doing' && st.lastEp >= 0) {
      if (!best || st.lastAt > best.st.lastAt) best = { c, st };
    }
  });
  const card = $('resumeCard');
  if (!best) { card.hidden = true; return; }
  const { c, st } = best;
  const ep = st.lastEp;
  card.hidden = false;
  $('resumeTitle').textContent = `${c.subjectName} · ${c.title}`;
  const epTitle = cleanEpTitle((c.parts && c.parts[ep] && c.parts[ep].t) || `第 ${ep + 1} 集`);
  $('resumeSub').textContent =
    `第 ${ep + 1}/${st.partCount} 集《${epTitle}》 · 看到 ${fmtTime(epRec(c.id, ep).watched)} · ${fmtDate(st.lastAt ? new Date(st.lastAt).toISOString() : null)} · ${state.online ? '云端同步' : '本地暂存'}`;
  $('resumeBar').style.width = st.pct + '%';
  $('resumePlay').dataset.play = c.id;
  $('resumePlay').dataset.ep = String(ep);
}

function render() {
  const list = filtered();
  const cards = $('cards');
  cards.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.forEach((c, i) => frag.appendChild(cardFor(c, i)));
  cards.appendChild(frag);

  const subj = (state.meta.subjects || []).find((s) => s.key === state.filters.subject);
  const title = subj ? '高中' + subj.name : '全部课程';
  const gradeText = state.filters.grade === 'all' ? '' : ' · ' + state.filters.grade;
  $('listTitle').textContent = title + gradeText;
  const sortText = state.filters.sort === 'score' ? '口碑优先' : state.filters.sort === 'play' ? '按播放量' : '按我的进度';
  const eps = list.reduce((s, c) => s + (c.partCount || 1), 0);
  $('listCount').textContent = `共 ${list.length} 门 / ${eps} 集 · ${sortText}`;
  $('empty').hidden = list.length > 0;

  renderResume();
}

/* ---------------- 播放器 ---------------- */

function firstUnwatched(c) {
  for (let i = 0; i < (c.partCount || 1); i++) {
    const r = epRec(c.id, i);
    if (!r || !r.done) return i;
  }
  return 0;
}

function openPlayer(id, epArg) {
  const course = courseById(id);
  if (!course) return;
  const st = courseStats(course);
  let ep = Number.isInteger(epArg) ? epArg : null;
  if (ep === null || ep < 0) ep = st.lastEp >= 0 ? st.lastEp : firstUnwatched(course);
  ep = Math.max(0, Math.min((course.partCount || 1) - 1, ep));

  const p = state.player;
  p.course = course;
  p.ep = ep;
  const rec = epRec(course.id, ep);
  p.duration = epDuration(course, ep);
  p.pos = rec ? Math.min(rec.watched, p.duration) : 0;
  p.dirty = false;
  p.ticking = false; // 估算计时默认关闭：必须用户明确点「开始计时」才累计
  p.lastInteract = Date.now();

  $('playerTitle').textContent = course.title;
  $('playerMeta').textContent =
    `${course.subjectName} · ${course.grade} · ${course.creator} · ${course.playText} 播放 · 口碑 ${course.score}`;
  const reasonBox = $('playerReason');
  if (course.reason) { reasonBox.textContent = '推荐理由：' + course.reason; reasonBox.hidden = false; }
  else reasonBox.hidden = true;
  $('playerOpen').href = course.url;
  loadFrame();
  renderEpList();
  updatePlayerUI();
  $('playerShell').hidden = false;
  document.body.style.overflow = 'hidden';
  startTicker();
}

function setPlayerLoading(on) {
  const box = $('playerLoading');
  if (!box) return;
  box.hidden = !on;
  const txt = $('playerLoadingText');
  if (txt) txt.textContent = '正在加载播放器…';
}

function loadFrame() {
  const p = state.player;
  const c = p.course;
  if (!c) return;
  // B 站 iframe 支持 &page=N 指定分 P；t= 为起始秒
  const src = c.embed.replace(/[?&]page=\d+/, '').replace(/&?t=\d+/, '') +
    '&page=' + (p.ep + 1) + '&t=' + Math.floor(p.pos);
  setPlayerLoading(true);
  // 网络慢时先给一句话，避免用户以为「点了没反应 / 跳走了」
  if (state.player.loadTimer) clearTimeout(state.player.loadTimer);
  state.player.loadTimer = setTimeout(() => {
    const txt = $('playerLoadingText');
    if (txt && !$('playerLoading').hidden) {
      txt.textContent = '加载较慢或失败，可点右上角「原站打开」';
    }
  }, 12000);
  $('playerFrame').src = src;
}

function renderEpList() {
  const p = state.player;
  const c = p.course;
  const box = $('epList');
  if (!box || !c) return;
  box.innerHTML = '';
  const n = c.partCount || 1;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const r = epRec(c.id, i);
    let cls = 'ep';
    if (i === p.ep) cls += ' on';
    if (r && r.done) cls += ' dot-done';
    const b = el('button', cls);
    b.type = 'button';
    b.dataset.ep = String(i);
    const raw = (c.parts && c.parts[i] && c.parts[i].t) || `第 ${i + 1} 集`;
    const t = cleanEpTitle(raw);
    b.append(el('span', 'epi', String(i + 1)), el('span', 'ept', t.length > 16 ? t.slice(0, 16) + '…' : t));
    b.title = t;
    frag.appendChild(b);
  }
  box.appendChild(frag);
  const cur = $('epList').querySelector('.ep.on');
  if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest' });

  const curTitle = cleanEpTitle((c.parts && c.parts[p.ep] && c.parts[p.ep].t) || `第 ${p.ep + 1} 集`);
  $('epLabel').textContent = `第 ${p.ep + 1}/${n} 集 · ${curTitle}`;
}

function updatePlayerUI() {
  const p = state.player;
  if (!p.course) return;
  $('posRange').max = String(Math.round(p.duration));
  $('posRange').value = String(Math.round(Math.min(p.pos, p.duration)));
  $('posText').textContent = fmtTime(p.pos) + ' / ' + fmtTime(p.duration);
  $('statWatched').textContent = fmtMinutes(p.pos);
  $('statPercent').textContent = Math.round((p.duration ? p.pos / p.duration : 0) * 100) + '%';
  if (p.dirty && state.online) $('statSave').textContent = '待上传';
  updateTickerButton();
}

function updateTickerButton() {
  const p = state.player;
  const btn = $('timerToggle');
  if (!btn) return;
  const done = (() => { const r = epRec(p.course && p.course.id, p.ep); return !!(r && r.done); })();
  btn.textContent = p.ticking ? '⏸ 暂停计时' : '▶ 开始计时';
  btn.classList.toggle('counting', !!p.ticking);
  btn.disabled = done;
  btn.title = done ? '本集已标记看完，无需计时' :
    (p.ticking ? '点击暂停估算计时' : '开始播放视频后点这里，进度才会按秒累计');
}

function startTicker() {
  stopTicker();
  state.player.timer = setInterval(() => {
    const p = state.player;
    if (!p.course) return;
    // 估算计时必须显式开启；页面切到后台、用户手动拖动时都不累计
    if (!p.ticking) return;
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - p.lastInteract < 1500) return; // 刚手动校正过，先不累计
    const rec = epRec(p.course.id, p.ep);
    if (rec && rec.done) return; // 已看完的集不再累计
    if (p.pos >= p.duration) {
      // 估算值到头：停表并提示，由用户自己确认，绝不自动标记完成/切下一集
      setTicking(false);
      toast('估算时长已到，请确认本集是否真看完（可用时间轴校正或点「标记已看完」）', 4000);
      return;
    }
    p.pos = Math.min(p.duration, p.pos + 1);
    p.dirty = true;
    updatePlayerUI();
    persistCurrent(false);
  }, 1000);
}

function setTicking(on) {
  const p = state.player;
  if (!p.course) return;
  p.ticking = Boolean(on);
  p.lastInteract = Date.now(); // 切换瞬间不累计，避免边界多跑一秒
  updatePlayerUI();
  updateTickerButton();
}

function stopTicker() {
  if (state.player.timer) {
    clearInterval(state.player.timer);
    state.player.timer = null;
  }
}

function persistCurrent(force) {
  const p = state.player;
  if (!p.course) return;
  const key = epKey(p.course.id, p.ep);
  const prev = state.progress[key] || {};
  const dur = Math.round(p.duration);
  const watched = Math.round(p.pos);
  state.progress[key] = {
    courseId: key,
    watched,
    duration: dur,
    percent: dur > 0 ? Math.round((watched / dur) * 1000) / 10 : 0,
    done: Boolean(prev.done),
    updatedAt: new Date().toISOString(),
  };
  markDirty(key);
  writeLocalProgress();
  if (force) queuePush(0); else queuePush(1500);
}

function finishEpisode() {
  const p = state.player;
  if (!p.course) return;
  const key = epKey(p.course.id, p.ep);
  setTicking(false);
  p.pos = p.duration;
  persistCurrent(true);
  state.progress[key].done = true;
  state.progress[key].percent = 100;
  queuePush(0);
  updatePlayerUI();
  const n = p.course.partCount || 1;
  toast(p.ep + 1 >= n ? '这门课已全部看完' : `第 ${p.ep + 1} 集已标记看完，可自行选择下一集`);
  renderEpList();
  render();
}

function markDone() {
  finishEpisode();
}

function switchEp(ep) {
  const p = state.player;
  if (!p.course) return;
  persistCurrent(true);
  p.ep = Math.max(0, Math.min((p.course.partCount || 1) - 1, ep));
  const rec = epRec(p.course.id, p.ep);
  p.duration = epDuration(p.course, p.ep);
  p.pos = rec ? Math.min(rec.watched, p.duration) : 0;
  p.dirty = false;
  p.ticking = false; // 换集后重新确认，不自动接着计时
  p.lastInteract = Date.now();
  loadFrame();
  renderEpList();
  updatePlayerUI();
  updateTickerButton();
  if (rec && rec.done) $('statPercent').textContent = '100%';
}

function closePlayer() {
  persistCurrent(true);
  stopTicker();
  state.player.course = null;
  if (state.player.loadTimer) { clearTimeout(state.player.loadTimer); state.player.loadTimer = null; }
  setPlayerLoading(false);
  $('playerFrame').src = 'about:blank';
  $('playerShell').hidden = true;
  document.body.style.overflow = '';
  render();
}

function bindPlayer() {
  // iframe 加载完成即撤掉「正在加载」遮罩
  $('playerFrame').addEventListener('load', () => {
    if (state.player.loadTimer) { clearTimeout(state.player.loadTimer); state.player.loadTimer = null; }
    const box = $('playerLoading');
    if (box) box.hidden = true;
  });
  $('cards').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (btn) openPlayer(btn.dataset.play, null);
  });
  $('resumePlay').addEventListener('click', (e) => {
    const ep = Number(e.currentTarget.dataset.ep);
    openPlayer(e.currentTarget.dataset.play, Number.isInteger(ep) && !Number.isNaN(ep) ? ep : null);
  });
  $('playerClose').addEventListener('click', closePlayer);
  $('playerBackdrop').addEventListener('click', closePlayer);
  $('saveClose').addEventListener('click', closePlayer);
  $('saveNow').addEventListener('click', () => {
    persistCurrent(true);
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    flushPush();
  });
  $('markDone').addEventListener('click', markDone);
  $('timerToggle').addEventListener('click', () => {
    const p = state.player;
    if (!p.course) return;
    if (!p.ticking && p.pos >= p.duration) {
      toast('估算时长已到，请先用时间轴校正位置再开始计时');
      return;
    }
    setTicking(!p.ticking);
    toast(p.ticking
      ? '开始估算计时：切到其他标签页会自动暂停'
      : '已暂停计时，进度不再累计');
  });

  $('epList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ep]');
    if (b) switchEp(Number(b.dataset.ep));
  });

  $('posRange').addEventListener('input', (e) => {
    state.player.pos = Number(e.target.value);
    state.player.dirty = true;
    state.player.lastInteract = Date.now();
    updatePlayerUI();
    persistCurrent(false);
  });

  document.querySelectorAll('[data-skip]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = state.player;
      p.pos = Math.max(0, Math.min(p.duration, p.pos + Number(b.dataset.skip)));
      p.dirty = true;
      p.lastInteract = Date.now();
      updatePlayerUI();
      persistCurrent(false);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('playerShell').hidden) closePlayer();
      if (!$('parentShell').hidden) closeParent();
    }
    if ($('playerShell').hidden || !state.player.course) return;
    if (e.key === 'ArrowRight' && e.shiftKey) switchEp(state.player.ep + 1);
    if (e.key === 'ArrowLeft' && e.shiftKey) switchEp(state.player.ep - 1);
  });
}

/* ---------------- 家长视图 ---------------- */

function openParent() {
  const bySubject = {};
  (state.meta.subjects || []).forEach((s) => {
    bySubject[s.key] = { name: s.name, total: 0, done: 0, doneEps: 0, eps: 0, watched: 0 };
  });
  let watchedTotal = 0;
  let doneTotal = 0;
  let doneEpsTotal = 0;
  let epsTotal = 0;

  state.courses.forEach((c) => {
    const st = courseStats(c);
    const bucket = bySubject[c.subject];
    epsTotal += st.partCount;
    if (!bucket) return;
    bucket.total += 1;
    bucket.eps += st.partCount;
    bucket.watched += st.watched;
    bucket.doneEps += st.doneEps;
    watchedTotal += st.watched;
    if (st.done) { bucket.done += 1; doneTotal += 1; }
    doneEpsTotal += st.doneEps;
  });

  const kpis = $('parentKpis');
  kpis.innerHTML = '';
  const stat = (label, value) => {
    const d = el('div', 'kpi');
    d.append(el('span', null, label), el('b', null, value));
    return d;
  };
  kpis.append(
    stat('累计学习', fmtShort(watchedTotal)),
    stat('看完的集数', doneEpsTotal + ' / ' + epsTotal),
    stat('整门完成', doneTotal + ' 门'),
    stat('最近同步', state.lastSyncAt ? fmtDate(state.lastSyncAt) : '未同步')
  );

  const rows = $('parentSubjects');
  rows.innerHTML = '';
  Object.keys(bySubject).forEach((k) => {
    const b = bySubject[k];
    const row = el('div', 'subject-row');
    const pct = b.eps ? Math.round((b.doneEps / b.eps) * 100) : 0;
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    row.append(
      el('span', 'nm', b.name),
      bar,
      el('span', 'val', `${b.doneEps}/${b.eps} 集 · ${fmtShort(b.watched)}`)
    );
    rows.appendChild(row);
  });

  const recent = [];
  state.courses.forEach((c) => {
    for (let i = 0; i < (c.partCount || 1); i++) {
      const r = epRec(c.id, i);
      if (r && r.watched > 0) recent.push({ c, i, r });
    }
  });
  recent.sort((a, b) => new Date(b.r.updatedAt) - new Date(a.r.updatedAt));

  const rbox = $('parentRecent');
  rbox.innerHTML = '';
  if (!recent.length) {
    rbox.appendChild(el('div', 'recent-row', '暂无学习记录'));
  } else {
    recent.slice(0, 10).forEach((x) => {
      const row = el('div', 'recent-row');
      const epT = cleanEpTitle((x.c.parts && x.c.parts[x.i] && x.c.parts[x.i].t) || `第 ${x.i + 1} 集`);
      row.append(
        el('span', 't', `${x.c.subjectName} · ${x.c.title} · 第 ${x.i + 1} 集`),
        el('span', 'w', (x.r.done ? '已看完 · ' : `看到 ${fmtTime(x.r.watched)} · `) + fmtDate(x.r.updatedAt))
      );
      row.title = epT;
      rbox.appendChild(row);
    });
  }

  $('parentTime').textContent = state.lastSyncAt ? fmtDate(state.lastSyncAt) : '本地暂存数据';
  $('parentShell').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeParent() {
  $('parentShell').hidden = true;
  document.body.style.overflow = '';
}

async function switchCode() {
  const input = prompt('输入学习码（6 位字母数字），留空则新建一个：');
  if (input === null) return;
  const code = input.trim().toUpperCase();
  if (!code) {
    localStorage.removeItem(LS_CODE);
    await connect();
    render();
    toast('已新建学习码 ' + state.code);
    return;
  }
  try {
    const data = await api('/api/household?code=' + encodeURIComponent(code));
    localStorage.setItem(LS_CODE, code);
    state.code = code;
    state.progress = data.household.progress || {};
    state.online = true;
    state.lastSyncAt = data.household.updatedAt;
    $('codeText').textContent = code;
    writeLocalProgress();
    setSync('ok', '进度已同步');
    render();
    closeParent();
    toast('已切换到学习码 ' + code);
  } catch (err) {
    toast('学习码不存在，或同步服务未连接');
  }
}

function bindParent() {
  $('parentBtn').addEventListener('click', openParent);
  $('parentClose').addEventListener('click', closeParent);
  $('parentBackdrop').addEventListener('click', closeParent);
  $('parentSwitch').addEventListener('click', switchCode);
  $('codeBtn').addEventListener('click', async () => {
    if (!state.code) return;
    try {
      await navigator.clipboard.writeText(state.code);
      toast('学习码 ' + state.code + ' 已复制，在别的设备输入即可接着看');
    } catch (_) {
      toast('学习码：' + state.code);
    }
  });
}

/* ---------------- 启动 ---------------- */

(async function boot() {
  try {
    await loadCourses();
  } catch (err) {
    $('empty').hidden = false;
    $('empty').textContent = '课程数据加载失败：' + err.message;
    return;
  }
  await connect();
  buildFilters();
  bindChipGroups();
  bindPlayer();
  bindParent();
  render();
})();
