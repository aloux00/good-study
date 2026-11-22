#!/usr/bin/env node
/**
 * 课栈 · 学习进度同步服务
 * 零第三方依赖，仅使用 Node 内置模块，可直接在 armbian 上运行。
 *   node server.js            # 默认端口 8080
 *   PORT=9000 node server.js
 *   DATA_DIR=/var/lib/kezhan node server.js
 *
 * 数据落在 DATA_DIR/store.json，按学习码分库。
 * 备份方法：直接复制该文件即可。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'backups');

const MAX_BODY = 512 * 1024;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// 可选访问令牌：设置后所有 /api/* 都需要带 Authorization: Bearer <TOKEN>
// 或 ?token=<TOKEN>。不设置则保持家用免配置模式。
const AUTH_TOKEN = String(process.env.AUTH_TOKEN || '').trim();

// 走 Nginx/Caddy 反代时，socket.remoteAddress 恒为反代自身地址，
// 限流会退化成「全员共用一个桶」，一人猜错锁住所有人。
// 设 TRUST_PROXY=1 后改用 X-Forwarded-For 的第一跳作为来源。
// 不要默认开启：没有反代时该头可被客户端伪造，等于让攻击者随意换桶绕过限流。
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));

// 简单的来源限流：同一来源在学习码校验失败时累计，超限临时封锁
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 20;
const failBuckets = new Map();

let store = { version: 1, households: {} };
let writeChain = Promise.resolve();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function loadStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.households) {
      store = parsed;
      log('store loaded:', Object.keys(store.households).length, 'households');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log('store read failed, starting empty:', err.message);
    await persist();
  }
}

function persist() {
  // 串行写入 + 原子替换，避免并发写坏文件
  writeChain = writeChain.then(async () => {
    const tmp = STORE_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fsp.rename(tmp, STORE_FILE);
  }).catch((err) => {
    log('persist failed:', err.message);
  });
  return writeChain;
}

function snapshot() {
  // 每日一份快照，保留最近 14 份；启动时先跑一次，避免首次备份要等 6 小时
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(ARCHIVE_DIR, `store-${stamp}.json`);
  fs.mkdir(ARCHIVE_DIR, { recursive: true }, () => {
    fs.access(file, (err) => {
      if (err) {
        // 源文件还没落盘时 copyFile 会失败，静默跳过即可
        fs.copyFile(STORE_FILE, file, () => {
          fs.readdir(ARCHIVE_DIR, (e, files) => {
            if (e) return;
            files.sort();
            files.slice(0, Math.max(0, files.length - 14)).forEach((f) => {
              fs.unlink(path.join(ARCHIVE_DIR, f), () => {});
            });
          });
        });
      }
    });
  });
}

setInterval(snapshot, 6 * 60 * 60 * 1000).unref();

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!store.households[code]) return code;
  }
  throw new Error('无法生成唯一学习码');
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function sanitizeRecord(input, previous) {
  const courseId = String(input.courseId || '').slice(0, 64);
  if (!courseId) return null;
  const watched = clampNumber(input.watched, 0, 60 * 60 * 100);
  const duration = clampNumber(input.duration, 0, 60 * 60 * 100);
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

function mergeProgress(household, updates) {
  const result = [];
  // 单集粒度记录，条目会随观看增长；上限防滥用，正常使用远达不到
  const MAX_ENTRIES = 5000;
  for (const raw of Array.isArray(updates) ? updates.slice(0, 80) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const courseId = String(raw.courseId || '').slice(0, 64);
    if (!courseId) continue;
    const prev = household.progress[courseId] || null;
    if (!prev && Object.keys(household.progress).length >= MAX_ENTRIES) continue;
    const next = sanitizeRecord(raw, prev);
    if (!next) continue;
    // 冲突合并：以客户端明确的进度为准，但累计观看时长只增不减
    if (prev) {
      if (next.watched < prev.watched) next.watched = prev.watched;
      if (!next.done) next.done = prev.done;
      const prevPct = prev.percent === null || prev.percent === undefined ? 0 : prev.percent;
      const nextPct = next.percent === null ? 0 : next.percent;
      // 进度百分比不允许后退，避免旧设备覆盖新设备的进度
      next.percent = Math.max(prevPct, nextPct);
    }
    // percent 以服务端为准重算，保证与 watched/duration 自洽
    if (next.duration > 0) {
      const calc = Math.round((next.watched / next.duration) * 1000) / 10;
      next.percent = next.done ? 100 : Math.max(calc, next.percent === null ? 0 : next.percent);
    }
    if (next.done) next.percent = 100;
    household.progress[courseId] = next;
    result.push(next);
  }
  household.updatedAt = new Date().toISOString();
  persist();
  return result;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function corsOrigin(req) {
  // 默认不放开跨域：前端与 API 同源，不需要 CORS 响应头。
  // 如需分离部署，设 CORS_ORIGIN=https://your.domain 指定白名单。
  const allowed = String(process.env.CORS_ORIGIN || '').trim();
  if (!allowed) return null;
  const origin = String(req.headers.origin || '');
  if (!origin) return null;
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) || list.includes('*') ? origin : null;
}

function clientKey(req) {
  if (TRUST_PROXY) {
    // X-Forwarded-For 形如 "client, proxy1, proxy2"，取最左一跳为原始客户端
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return String(req.socket.remoteAddress || 'unknown');
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

function isLocked(key) {
  const rec = failBuckets.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) {
    failBuckets.delete(key);
    return false;
  }
  return rec.count > FAIL_LIMIT;
}

setInterval(() => {
  // 清理过期限流记录，避免长期运行内存增长
  const now = Date.now();
  for (const [k, v] of failBuckets) if (now - v.first > FAIL_WINDOW_MS) failBuckets.delete(k);
}, FAIL_WINDOW_MS).unref();

function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') && header.slice(7).trim() === AUTH_TOKEN;
}

function publicHousehold(code) {
  const h = store.households[code];
  return {
    code: h.code,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
    progress: h.progress,
  };
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  // 健康检查不鉴权，方便反代 / systemd 探活
  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, households: Object.keys(store.households).length });
  }

  const key = clientKey(req);

  // 鉴权失败的尝试要计数，否则令牌可被无限次爆破。
  // 限流只作用于「未通过鉴权」的请求——全家共用一个出口 IP，
  // 若把已认证请求一并锁死，某人输错几次会把所有人关在门外。
  if (!checkAuth(req)) {
    if (isLocked(key)) {
      return sendJson(res, 429, { error: 'too_many_requests', message: '尝试过于频繁，请稍后再试' });
    }
    takeFail(key);
    return sendJson(res, 401, { error: 'unauthorized', message: '缺少或错误的访问令牌' });
  }

  // 未设令牌的家用模式：学习码是唯一凭证，猜错要限流，防 6 位码被枚举。
  // 设了令牌则由令牌把关，这里不再锁，避免家中多人共用 IP 时互相连坐。
  if (!AUTH_TOKEN && isLocked(key)) {
    return sendJson(res, 429, { error: 'too_many_requests', message: '尝试过于频繁，请稍后再试' });
  }

  if (route === '/api/household' && req.method === 'POST') {
    const body = await readBody(req);
    const requested = normalizeCode(body.code);
    if (requested && requested.length >= 4) {
      if (store.households[requested]) {
        takeFail(key);
        return sendJson(res, 409, { error: 'code_exists', message: '该学习码已存在，请直接输入登录' });
      }
      store.households[requested] = {
        code: requested,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        progress: {},
      };
      persist();
      return sendJson(res, 201, { household: publicHousehold(requested) });
    }
    const code = newCode();
    store.households[code] = {
      code,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: {},
    };
    await persist();
    log('household created', code);
    return sendJson(res, 201, { household: publicHousehold(code) });
  }

  if (route === '/api/household' && req.method === 'GET') {
    const code = normalizeCode(url.searchParams.get('code'));
    if (!code || !store.households[code]) {
      // 学习码不存在才计失败，避免家长正常刷新被误伤
      takeFail(key);
      return sendJson(res, 404, { error: 'not_found', message: '学习码不存在' });
    }
    return sendJson(res, 200, { household: publicHousehold(code) });
  }

  if (route === '/api/progress' && req.method === 'PUT') {
    // 请求流只能读一次：先完整读 body，再从 query 或 body 里取学习码
    const body = await readBody(req);
    const code = normalizeCode(url.searchParams.get('code') || body.code);
    if (!code || !store.households[code]) {
      takeFail(key);
      return sendJson(res, 404, { error: 'not_found', message: '学习码不存在' });
    }
    const merged = mergeProgress(store.households[code], body.updates);
    return sendJson(res, 200, {
      merged,
      updatedAt: store.households[code].updatedAt,
      progress: store.households[code].progress,
    });
  }

  return sendJson(res, 404, { error: 'no_route' });
}

function safeJoin(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0]);
  } catch (_) {
    return null; // 非法百分号编码
  }
  // 拒绝含空字节的路径，避免 C 层截断
  if (decoded.indexOf(String.fromCharCode(0)) !== -1) return null;
  const target = path.normalize(path.join(root, decoded));
  // 前缀必须带分隔符，否则同级目录 publicXXX 会被误判为 public 内
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== path.normalize(root) && !target.startsWith(base)) return null;
  return target;
}

async function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = safeJoin(PUBLIC_DIR, rel);
  if (!file) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
    }
    const data = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>页面不存在。<a href="/">回到课栈</a></p>');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': corsOrigin(req),
          'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          Vary: 'Origin',
        });
        return res.end();
      }
      const allow = corsOrigin(req);
      if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    return await serveStatic(req, res, url);
  } catch (err) {
    log('request error:', req.method, url.pathname, err.message);
    if (!res.headersSent) sendJson(res, 400, { error: 'bad_request', message: err.message });
    else res.end();
  }
});

loadStore().then(() => {
  server.listen(PORT, HOST, () => {
    log(`课栈已启动 http://${HOST}:${PORT}`);
    log(`数据目录 ${DATA_DIR}`);
    log(`访问令牌 ${AUTH_TOKEN ? '已启用' : '未设置（家用模式）'}`);
    snapshot(); // 启动立即备份一次
  });
});

process.on('SIGTERM', async () => {
  await persist();
  server.close(() => process.exit(0));
});
process.on('SIGINT', async () => {
  await persist();
  server.close(() => process.exit(0));
});
