/**
 * 课栈 · Cloudflare Pages Functions 版进度同步 API
 *
 * 与原 server.js 的 HTTP 契约完全一致，前端代码不需要任何改动：
 *   GET  /api/health               健康检查（免鉴权）
 *   POST /api/household            创建学习码（body.code 可指定）
 *   GET  /api/household?code=X     读取家庭与全部进度
 *   PUT  /api/progress?code=X      合并写入进度
 *
 * 存储换成 D1，其余语义（只增不减、percent 不回退、限流、令牌）照搬原实现。
 */

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_BODY = 512 * 1024;
const MAX_UPDATES = 80;
const MAX_ENTRIES = 5000;
const MAX_SECONDS = 60 * 60 * 100;

const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 20;

// 进程内限流：每个 isolate 独立，冷启动清零。
// 对「防 6 位码被枚举」够用；要跨实例精确限流需换 Durable Objects。
const failBuckets = new Map();

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function newCode() {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return code;
}

async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > MAX_BODY) throw new Error('payload_too_large');
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('invalid_json');
  }
}

// Cloudflare 已经解析好真实客户端地址，不需要信任 X-Forwarded-For
function clientKey(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function isLocked(key) {
  const rec = failBuckets.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) {
    failBuckets.delete(key);
    return false;
  }
  return rec.count > FAIL_LIMIT;
}

function takeFail(key) {
  const now = Date.now();
  const rec = failBuckets.get(key);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) {
    failBuckets.set(key, { count: 1, first: now });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function checkAuth(request, env) {
  const token = String(env.AUTH_TOKEN || '').trim();
  if (!token) return true;
  const header = String(request.headers.get('authorization') || '');
  return header.startsWith('Bearer ') && header.slice(7).trim() === token;
}

function sanitizeRecord(input, previous) {
  const courseId = String(input.courseId || '').slice(0, 64);
  if (!courseId) return null;
  const watched = clampNumber(input.watched, 0, MAX_SECONDS);
  const duration = clampNumber(input.duration, 0, MAX_SECONDS);
  const percent = clampNumber(input.percent, 0, 100);
  return {
    courseId,
    watched: watched === null ? (previous ? previous.watched : 0) : Math.round(watched),
    duration: duration === null ? (previous ? previous.duration : 0) : Math.round(duration),
    percent: percent === null ? (previous ? previous.percent : null) : Math.round(percent * 10) / 10,
    done: Boolean(input.done ?? (previous ? previous.done : false)),
    updatedAt: new Date().toISOString(),
  };
}

function rowToRecord(r) {
  return {
    courseId: r.course_id,
    watched: r.watched,
    duration: r.duration,
    percent: r.percent,
    done: Boolean(r.done),
    updatedAt: r.updated_at,
  };
}

async function loadProgress(env, code) {
  const { results } = await env.DB
    .prepare('SELECT course_id, watched, duration, percent, done, updated_at FROM progress WHERE code = ?')
    .bind(code)
    .all();
  const progress = {};
  for (const r of results || []) progress[r.course_id] = rowToRecord(r);
  return progress;
}

async function householdExists(env, code) {
  if (!code) return false;
  const row = await env.DB
    .prepare('SELECT code FROM households WHERE code = ?')
    .bind(code)
    .first();
  return Boolean(row);
}

const UPSERT = `INSERT INTO progress (code, course_id, watched, duration, percent, done, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(code, course_id) DO UPDATE SET
  watched    = excluded.watched,
  duration   = excluded.duration,
  percent    = excluded.percent,
  done       = excluded.done,
  updated_at = excluded.updated_at`;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  try {
    // 健康检查免鉴权，方便探活
    if (route === '/api/health') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM households').first();
      return json(200, { ok: true, households: row ? row.n : 0 });
    }

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    const key = clientKey(request);
    const hasToken = Boolean(String(env.AUTH_TOKEN || '').trim());

    // 鉴权失败的尝试计数，否则令牌可被无限次爆破
    if (!checkAuth(request, env)) {
      if (isLocked(key)) {
        return json(429, { error: 'too_many_requests', message: '尝试过于频繁，请稍后再试' });
      }
      takeFail(key);
      return json(401, { error: 'unauthorized', message: '缺少或错误的访问令牌' });
    }

    // 家用模式（未设令牌）：学习码是唯一凭证，猜错要限流
    if (!hasToken && isLocked(key)) {
      return json(429, { error: 'too_many_requests', message: '尝试过于频繁，请稍后再试' });
    }

    if (route === '/api/household' && method === 'POST') {
      const body = await readBody(request);
      const now = new Date().toISOString();
      const requested = normalizeCode(body.code);

      if (requested && requested.length >= 4) {
        const res = await env.DB
          .prepare('INSERT INTO households (code, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING')
          .bind(requested, now, now)
          .run();
        if (!res.meta || res.meta.changes === 0) {
          takeFail(key);
          return json(409, { error: 'code_exists', message: '该学习码已存在，请直接输入登录' });
        }
        return json(201, { household: { code: requested, createdAt: now, updatedAt: now, progress: {} } });
      }

      // 自动生成：碰撞概率极低，重试几次足够
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        const res = await env.DB
          .prepare('INSERT INTO households (code, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING')
          .bind(code, now, now)
          .run();
        if (res.meta && res.meta.changes > 0) {
          return json(201, { household: { code, createdAt: now, updatedAt: now, progress: {} } });
        }
      }
      return json(500, { error: 'code_generation_failed', message: '生成学习码失败，请重试' });
    }

    if (route === '/api/household' && method === 'GET') {
      const code = normalizeCode(url.searchParams.get('code'));
      if (!(await householdExists(env, code))) {
        takeFail(key);
        return json(404, { error: 'not_found', message: '学习码不存在' });
      }
      const row = await env.DB
        .prepare('SELECT code, created_at, updated_at FROM households WHERE code = ?')
        .bind(code)
        .first();
      const progress = await loadProgress(env, code);
      return json(200, {
        household: { code: row.code, createdAt: row.created_at, updatedAt: row.updated_at, progress },
      });
    }

    if (route === '/api/progress' && method === 'PUT') {
      const body = await readBody(request);
      const code = normalizeCode(url.searchParams.get('code') || body.code);
      if (!(await householdExists(env, code))) {
        takeFail(key);
        return json(404, { error: 'not_found', message: '学习码不存在' });
      }

      const updates = Array.isArray(body.updates) ? body.updates.slice(0, MAX_UPDATES) : [];

      // 只取本次涉及的条目，避免每次全表读
      const ids = [...new Set(
        updates
          .map((u) => String((u && u.courseId) || '').slice(0, 64))
          .filter(Boolean)
      )];

      const prevMap = {};
      if (ids.length) {
        const holders = ids.map(() => '?').join(',');
        const { results } = await env.DB
          .prepare(`SELECT course_id, watched, duration, percent, done, updated_at FROM progress WHERE code = ? AND course_id IN (${holders})`)
          .bind(code, ...ids)
          .all();
        for (const r of results || []) prevMap[r.course_id] = rowToRecord(r);
      }

      const countRow = await env.DB
        .prepare('SELECT COUNT(*) AS n FROM progress WHERE code = ?')
        .bind(code)
        .first();
      let entries = countRow ? countRow.n : 0;

      const merged = [];
      const stmts = [];
      const now = new Date().toISOString();

      for (const raw of updates) {
        if (!raw || typeof raw !== 'object') continue;
        const prev = prevMap[String(raw.courseId || '').slice(0, 64)] || null;
        if (!prev && entries >= MAX_ENTRIES) continue;
        const next = sanitizeRecord(raw, prev);
        if (!next) continue;

        // 冲突合并：累计观看时长只增不减
        if (prev) {
          if (next.watched < prev.watched) next.watched = prev.watched;
          if (!next.done) next.done = prev.done;
          const prevPct = prev.percent === null || prev.percent === undefined ? 0 : prev.percent;
          const nextPct = next.percent === null ? 0 : next.percent;
          next.percent = Math.max(prevPct, nextPct);
        }
        // percent 以服务端为准重算，保证与 watched/duration 自洽
        if (next.duration > 0) {
          const calc = Math.round((next.watched / next.duration) * 1000) / 10;
          next.percent = next.done ? 100 : Math.max(calc, next.percent === null ? 0 : next.percent);
        }
        if (next.done) next.percent = 100;

        if (!prev) entries += 1;
        prevMap[next.courseId] = next;
        merged.push(next);
        stmts.push(
          env.DB.prepare(UPSERT).bind(
            code,
            next.courseId,
            next.watched,
            next.duration,
            next.percent === null ? 0 : next.percent,
            next.done ? 1 : 0,
            next.updatedAt
          )
        );
      }

      if (stmts.length) await env.DB.batch(stmts);
      await env.DB.prepare('UPDATE households SET updated_at = ? WHERE code = ?').bind(now, code).run();

      const progress = await loadProgress(env, code);
      return json(200, { merged, updatedAt: now, progress });
    }

    return json(404, { error: 'no_route' });
  } catch (err) {
    if (err && err.message === 'payload_too_large') {
      return json(413, { error: 'payload_too_large', message: '请求体过大' });
    }
    if (err && err.message === 'invalid_json') {
      return json(400, { error: 'invalid_json', message: '请求体不是合法 JSON' });
    }
    console.error('api error', err && err.stack ? err.stack : err);
    return json(500, { error: 'internal_error', message: '服务端异常' });
  }
}
