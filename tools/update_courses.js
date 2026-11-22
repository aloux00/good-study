#!/usr/bin/env node
/**
 * 课栈课程数据维护脚本（零依赖，只用 Node 内置模块）
 *
 * 参考 limin112/bilipicks 的 update.py，针对课栈的 courses.json 设计。
 * 只用 B 站公开接口读信息，不登录、不抓流。数据放在一行 JSON 里，读写都不改其它字段。
 *
 * 用法（在仓库根目录运行）：
 *   node tools/update_courses.js            刷新：补封面、检测失效、刷新时长、生成推荐理由
 *   node tools/update_courses.js --check    只检查出报告，不改文件
 *   node tools/update_courses.js --deploy   刷新后 git 提交并推送（GitHub Pages 可自动上线）
 *   node tools/update_courses.js --no-tiers-like  跳过封面 CDN 缩图（调试用，一般不需要）
 *
 * 行为约定：
 *   - 失效视频（视频被删/不可见）标记 dead:true，前端自动隐藏；恢复可看时自动清除标记。
 *   - 标题、集数、时长这类人工核对过的数据只提示变化、不覆盖。
 *   - cover 是 CDN 缩图地址（约 120KB → 20KB）；封面加载失败时前端回退渐变色块。
 *   - reason 是推荐理由，人工改过的话设 reasonLocked:true，脚本不再覆盖。
 *   - 每个请求间隔 500ms，失败重试一次，避免给 B 站添麻烦。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'public', 'data', 'courses.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PAUSE = 500;              // 请求间隔（毫秒）
const TIMEOUT = 12000;
const CDN_SUFFIX = '@672w_378h_1c.webp';

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const DEPLOY = argv.includes('--deploy');

// B 站错误码 → 人话
const ERRORS = {
  '-404': '视频不存在或已删除',
  62002: '稿件不可见',
  62004: '稿件审核中',
  62012: '仅 UP 主自己可见',
  '-412': '请求被风控（IP 受限），稍后再试',
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fetchView(bvid) {
  return new Promise((resolve) => {
    const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid);
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ ok: true, json: JSON.parse(buf) }); }
        catch (e) { resolve({ ok: false, err: '响应不是 JSON：' + buf.slice(0, 80) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, err: e.message }));
    req.setTimeout(TIMEOUT, () => { req.destroy(); resolve({ ok: false, err: '请求超时' }); });
  });
}

async function viewWithRetry(bvid) {
  let r = await fetchView(bvid);
  if (!r.ok) { await sleep(2000); r = await fetchView(bvid); }
  return r;
}

// 只保留 B 站官方 CDN 域名，避免把任意 URL 写进数据
function coverUrl(pic) {
  if (!pic) return '';
  if (pic.startsWith('//')) pic = 'https:' + pic;
  if (pic.startsWith('http://')) pic = 'https://' + pic.slice(7);
  try {
    const u = new URL(pic);
    if (!/(^|\.)(hdslb|biliimg)\.com$/.test(u.hostname)) return '';
    return u.origin + u.pathname + CDN_SUFFIX;
  } catch (_) { return ''; }
}

// 推荐理由：优先人工锁定，否则按数据生成一句，绝不编造具体内容
function makeReason(c) {
  if (c.reasonLocked && c.reason) return c.reason;
  const bits = [];
  if (c.creator) bits.push(c.creator + '主讲');
  if (c.topic) bits.push(c.topic);
  else if (c.kind === '系列课') bits.push('系统课');
  if (c.partCount > 1) bits.push(c.partCount + ' 集');
  let s = bits.join(' · ');
  if (c.tags && c.tags.length) s += '；覆盖' + c.tags.slice(0, 3).join('、');
  if (c.score) s += '；口碑 ' + c.score + ' 分';
  return s || (c.subjectName || '') + '优质课程';
}

function load() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function save(data) {
  // 保持单行紧凑格式、UTF-8 不转义中文，末尾补一个换行
  fs.writeFileSync(DATA_FILE, JSON.stringify(data) + '\n', 'utf8');
}

function deploy(msg) {
  const rel = path.relative(ROOT, DATA_FILE).replace(/\\/g, '/');
  try {
    const st = execFileSync('git', ['status', '--porcelain', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!st) { console.log('没有变化，不用部署。'); return; }
    execFileSync('git', ['add', rel], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', msg], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['push'], { cwd: ROOT, stdio: 'inherit' });
    console.log('已推送。');
  } catch (e) {
    console.error('git 部署失败：' + e.message);
    process.exitCode = 1;
  }
}

function printReport(rep) {
  const labels = {
    dead: '失效（前端将自动隐藏，建议替换）',
    revived: '恢复可看（已自动取消隐藏）',
    retitled: 'B 站标题变了（只提示，不覆盖人工标题）',
    reowner: 'UP 主名字变了（只提示）',
    warn: '其它提醒',
  };
  let any = false;
  for (const k of Object.keys(labels)) {
    if (!rep[k].length) continue;
    any = true;
    console.log('\n' + labels[k] + '：');
    rep[k].forEach((x) => console.log('  - ' + x));
  }
  if (!any) console.log('\n一切正常。');
}

async function main() {
  const data = load();
  const courses = data.courses || [];
  console.log('课程数：' + courses.length + (CHECK_ONLY ? '（--check 只检查，不写入）' : ''));

  const rep = { dead: [], revived: [], retitled: [], reowner: [], warn: [] };
  let updatedCover = 0, updatedReason = 0;

  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    process.stdout.write('\r  处理 ' + (i + 1) + '/' + courses.length + '  ' + c.id + '   ');
    const r = await viewWithRetry(c.bvid);
    if (!r.ok) { rep.warn.push(c.id + ' ' + c.bvid + '：' + r.err); continue; }

    const j = r.json;
    const code = j.code;
    if (code !== 0) {
      if (!c.dead) rep.dead.push(c.id + '《' + c.title + '》：' + (ERRORS[code] || '错误码 ' + code));
      c.dead = true;
      await sleep(PAUSE);
      continue;
    }
    if (c.dead) { delete c.dead; rep.revived.push(c.id + '《' + c.title + '》'); }

    const d = j.data || {};
    // 本地标题是人工清洗过的短标题，和 B 站原标题天然不同。
    // 首次运行只记基线不提示；之后 B 站标题真的变了才提示。
    if (d.title) {
      if (!c.titleAtSource) c.titleAtSource = d.title;
      else if (d.title !== c.titleAtSource) {
        rep.retitled.push(c.id + '《' + c.title + '》→ B 站现为「' + d.title + '」（未改本地标题）');
        c.titleAtSource = d.title;
      }
    }
    const owner = (d.owner || {}).name || '';
    if (owner && c.creator && owner !== c.creator) {
      rep.reowner.push(c.id + '：本地「' + c.creator + '」→ B 站「' + owner + '」');
    }
    const pic = coverUrl(d.pic);
    if (pic && pic !== c.cover) { c.cover = pic; updatedCover++; }
    const reason = makeReason(c);
    if (reason && reason !== c.reason) { c.reason = reason; updatedReason++; }

    await sleep(PAUSE);
  }
  console.log('\n');

  if (!CHECK_ONLY) {
    data.generatedAt = new Date().toISOString().slice(0, 10);
    save(data);
    console.log('已写入：' + updatedCover + ' 个封面，' + updatedReason + ' 条推荐理由。');
  }
  printReport(rep);

  if (DEPLOY && !CHECK_ONLY) deploy('课栈：课程数据刷新 ' + data.generatedAt);
}

main().catch((e) => { console.error(e); process.exit(1); });
