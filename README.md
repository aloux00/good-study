# 课栈 · 高中学习中心

一个可以自己托管在 armbian / 树莓派 / 任意 Linux 上的高中课程库：
按年级、学科筛选口碑课程，点开即播，**学习进度存在你自己的服务器上，换设备接着看**。

当前收录：高中数学、物理、化学、英语 四科，共 56 门课程 / 2990 个分集。

---

## 一、它解决了什么

| 痛点 | 做法 |
|---|---|
| 网上课程太散，找不到好的 | 只收录 B 站播放量高、口碑好的成体系课程，按学科 / 年级 / 分集整理 |
| 进度只存在浏览器里，换设备就丢 | 进度写入你自己的服务端，凭 6 位学习码在任意设备恢复 |
| 家长想知道学到哪了 | 内置只读「家长视图」，不改动任何数据 |
| 想放到自己的机器上 | 单个 Node 文件，零第三方依赖，一条命令启动 |

## 二、特点

- **零依赖**：只用 Node.js 内置模块，不需要 `npm install`，不需要数据库。
- **进度按集记录**：一集一个进度点（如 `math-01#12`）。198 集的合集也不会因为「总时长」而失真。
- **冲突不丢进度**：服务端合并时观看时长只增不减、完成状态不回退、百分比不倒退。手机看到 30 分钟，平板上只看到 10 分钟，同步后保留 30 分钟。
- **原子写盘 + 每日备份**：先写临时文件再重命名，避免断电写坏；每 6 小时快照一份，保留最近 14 份。
- **离线可用**：断网时进度先存本地，恢复网络自动补传。
- **深色模式 / 移动端**自适应。

## 三、部署到 armbian

### 1. 装 Node.js（18 或更高）

```bash
# armbian 自带的源通常就有
sudo apt update && sudo apt install -y nodejs
node -v      # 需要 v18+
```

如果版本太低，用 NodeSource 或 nvm 装新版：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. 放好文件

把整个目录拷到主机上，例如 `/opt/kezhan`：

```
/opt/kezhan/
├── server.js
└── public/
    ├── index.html
    ├── app.css
    ├── app.js
    └── data/courses.json
```

### 3. 先手动跑起来试试

```bash
cd /opt/kezhan
PORT=8080 DATA_DIR=/var/lib/kezhan node server.js
```

浏览器打开 `http://<你的armbian局域网IP>:8080` 就能用了。

### 4. 用 systemd 常驻

新建 `/etc/systemd/system/kezhan.service`：

```ini
[Unit]
Description=Kezhan study center
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/kezhan
ExecStart=/usr/bin/node /opt/kezhan/server.js
Environment=PORT=8080
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/var/lib/kezhan
Restart=always
RestartSec=3
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/kezhan
sudo chown -R www-data:www-data /var/lib/kezhan /opt/kezhan
sudo systemctl daemon-reload
sudo systemctl enable --now kezhan
sudo systemctl status kezhan
```

### 5. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只给本机用可设 `127.0.0.1` |
| `DATA_DIR` | `./data` | 进度数据目录，**建议放在独立目录便于备份** |
| `AUTH_TOKEN` | 空 | **公网暴露时强烈建议设置**。设了之后所有 `/api/*` 需要 `Authorization: Bearer <TOKEN>`（**不支持**把令牌放在 URL 查询串里，避免出现在访问日志/浏览器历史中）；前端首次会弹框让你粘贴一次，存本机，之后所有请求自动带头。健康检查 `/api/health` 始终免鉴权。 |
| `CORS_ORIGIN` | 空 | 默认**不发送**任何 CORS 头（前后端同源，无需跨域）。仅在分离部署时填白名单，多个用逗号分隔，如 `https://a.com,https://b.com`。 |
| `TRUST_PROXY` | 空（关闭） | **仅当你在前面套了 Nginx/Caddy 反向代理时才设 `1`**。开启后限流按 `X-Forwarded-For` 的第一跳（真实客户端）计数。默认关闭是有原因的：没有反代时这个头可被客户端随意伪造，等于给攻击者无限换桶绕过限流。 |

#### 安全说明（2026-11-21 审查后加固）

- 学习码本身就是凭证，知道即可读写该码进度。**仅适合家庭内网**。
- 若要从公网访问，请二选一：
  1. `HOST=127.0.0.1` + Nginx/Caddy 反向代理加 Basic Auth / HTTPS；
  2. 设 `AUTH_TOKEN=<一串随机字符>`，让 API 层自带一道门。
  - 走反向代理时，记得同时设 `TRUST_PROXY=1`。否则限流看到的来源永远是反代自己的地址（如 `127.0.0.1`），一个人猜错 20 次就会把全家人一起锁在门外。
- 失败限流：同一来源 10 分钟内校验失败超过 20 次会被临时拒绝（HTTP 429），用于抵挡爆破。
  - **未设令牌（家用模式）**：猜错的查询会计数，防 6 位学习码被枚举；触发后该 IP 会被锁一段时间，连正确的码也一起拒到窗口结束。
  - **已设令牌**：令牌校验失败的尝试同样计数并被限流；**已通过鉴权的请求不会被锁**——全家共用一个出口 IP，否则一人输错几次会把所有人关在门外。
  - 计数器存在**进程内存**里：服务重启即清零，多实例之间不共享。单机自建没有影响；将来若要跑多副本，需要换成 Redis 之类的共享存储——那已超出本项目「零第三方依赖」的定位，是另一个取舍。
- 目录穿越防护使用带分隔符（`path.sep`）的前缀比对；非法百分号编码与含 `%00` 空字节的路径直接拒绝。已用构造同级 `publicXXX` 目录的用例实测拦截。
- `PUT /api/progress` 的请求流只读一次，学习码放 query 或放 body 都可以（早期版本两者同时处理会挂起，已修）。
- 默认**不发送** CORS 通配头，只有 `CORS_ORIGIN` 白名单内的来源才会收到 `Access-Control-Allow-Origin`。

#### 开 `TRUST_PROXY` 的前提（很重要，配错等于没防）

`TRUST_PROXY=1` 时，限流按 `X-Forwarded-For` 的**第一跳**当作真实客户端。这只有在反向代理**自己覆盖**该头时才成立。如果反代只是原样透传客户端发来的 `X-Forwarded-For`，攻击者就可以每次请求都伪造一个不同的值，等于无限换桶，限流形同不存在。

Nginx 要用 `$remote_addr` 覆盖整头（**不要**用常见的 `$proxy_add_x_forwarded_for`，它是「追加」，会把客户端自带的伪造段留在最左边，而本程序读的正是最左一跳）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖，而不是追加
    proxy_set_header X-Real-IP       $remote_addr;
    proxy_set_header Host            $host;
}
```

> `$remote_addr` 是 TCP 对端地址，无法伪造；用它覆盖后，客户端自己发的 `X-Forwarded-For` 会被整段丢弃。

Caddy 默认会正确处理，无需额外设置：

```
example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**实测对照**（客户端每次伪造不同的 `X-Forwarded-For` 连打 30 次错误令牌，服务端开 `TRUST_PROXY=1`）：

| 反代转发方式 | 命中 429 次数 | 结果 |
|---|---|---|
| 覆盖为 `$remote_addr`（本 README 推荐） | 9 次后锁定 | 伪造被丢弃，限流正常生效 |
| 追加 `$proxy_add_x_forwarded_for`（Nginx 常见默认写法） | 0 次 | 每次换桶，**限流完全失效** |

这张表是本项目最容易踩的坑：`$proxy_add_x_forwarded_for` 在别的项目里通常是正确写法，但本程序取 XFF 的**最左**一跳，而追加方式恰好把客户端伪造值留在最左边。所以这里必须用覆盖。

**不确定就不要开** `TRUST_PROXY`：宁可全家共用一个限流桶（难受但安全），也不要开着却被伪造头绕过（看似正常但无防护）。

## 四、怎么用

1. 第一次打开会自动生成一个 **6 位学习码**（右上角）。点一下即可复制。
2. 在手机、平板、另一台电脑上打开同一地址，点「家长视图 → 切换学习码」，输入这个码，进度就同步过来了。
3. 打开课程后，**先点播放器下方的「▶ 开始计时」**，进度才会按秒累计并定时上传；暂停视频时再点「⏸ 暂停计时」，切到别的标签页也会自动暂停。也可以拖动时间轴 / ±分钟校正、点「标记已看完」、点「立即同步」手动触发。
   - 估算时长累计到片尾时**只停表并提示，不会自动标记完成、也不会自动切下一集**，由你确认后自己选下一集。换集后计时默认关闭，需要重新点「开始计时」。
4. 家长打开「家长视图」即可看到累计学习时长、**看完的集数**、各学科分布与最近学习记录，**只读，不会改动进度**。

> 卡片上的「已看 x/y 集」是**开始看过的集数**（含未看完），家长视图的「看完的集数」只统计**标记为看完**的集。两者口径不同，不是数据丢了。

## 五、备份与恢复

进度全部在 `DATA_DIR/store.json` 里，按学习码分库。

```bash
# 备份
sudo cp /var/lib/kezhan/store.json ~/kezhan-store-$(date +%F).json

# 恢复
sudo systemctl stop kezhan
sudo cp ~/kezhan-store-2026-11-21.json /var/lib/kezhan/store.json
sudo systemctl start kezhan
```

`DATA_DIR/backups/` 下还有服务自动生成的每日快照（保留 14 份），**服务一启动就先做一次**，不用等到第一个 6 小时周期。

## 六、接口（自建客户端时可用）

> 若设置了 `AUTH_TOKEN`，除 `/api/health` 外都需要带 `Authorization: Bearer <TOKEN>`。**早期版本支持过 `?token=<TOKEN>`，已移除**——URL 里的令牌会留在访问日志与浏览器历史里。校验失败限流触发时返回 `429`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查，返回家庭数 |
| `POST` | `/api/household` | 新建学习码。body `{}` 自动生成，传 `{"code":"ABC123"}` 可指定 |
| `GET` | `/api/household?code=ABC123` | 读取该码的全部进度 |
| `PUT` | `/api/progress?code=ABC123` | 写入进度，body `{"updates":[...]}`，单次最多 80 条 |

单条进度记录：

```json
{
  "courseId": "physics-13#1",
  "watched": 620,
  "duration": 892,
  "percent": 69.5,
  "done": false
}
```

`courseId` 格式为 `课程ID#集序号`（集序号从 0 开始）。

## 七、已知限制（请务必了解）

1. **内嵌播放器无法回读播放时间**。B 站 iframe 是跨域的，页面拿不到播放器的真实进度。当前实现是：用户点「开始计时」后才按秒累计；切到后台、暂停计时都会停下。所以：
   - 点开视频后要**手动点一次「▶ 开始计时」**，不点则进度不动（这是有意设计：避免没在播放时进度自己跑）；
   - 暂停视频时记得点「⏸ 暂停计时」，否则估算会继续走；
   - 中途拖动进度条或用倍速看，累计值会与真实不一致，可用时间轴、「+1 分钟 / +5 分钟」按钮或「标记已看完」校正；
   - **估算到头不会自动切下一集、也不会自动标记完成**——跨域无法判断视频是否真的播完，交给你自己确认。

   这是浏览器跨域安全策略的限制，不是 bug。若要精确到秒，需要改用官方开放接口或自建播放源。

2. **播放依赖你自己的网络出口，B 站会按 IP 风控**。这是本项目最需要注意的一条，务必读：
   - 本机（浏览器）打开课栈后，播放器是直接连 B 站的。若该网络的出口 IP 被 B 站判定异常，播放器会显示「非常抱歉，本视频可能由于以下原因导致无法正常播放」，并在后台把 `playurl` 接口答成 `{"code":-400,"message":"请求错误"}`。
   - 判断方法：**用同一个浏览器直接打开 `https://www.bilibili.com/video/<BV号>`**。如果原站也显示「错误号 412 · 触发哔哩哔哩安全风控策略」，那就是 IP 被风控，与课栈无关；换个网络（家用宽带/手机热点）通常立刻恢复。
   - 所以：**开发/测试所在的服务器或云主机 IP 被风控，不代表程序坏了，也不代表它不能在你的 armbian 上用**。请以你实际使用的家庭网络为准。
   - 若确实需要长期稳定播放，可考虑改用官方开放接口或自建播放源（见第 1 条），这是绕过风控的唯一正当方式。

3. **不要随意改动 iframe 的属性**。当前组合是 `referrerpolicy="no-referrer"` + URL **不带** `isOutside=true`。
   - 说明清楚一点：曾经观察到「带 `isOutside=true` 或改成 `strict-origin-when-cross-origin` 时，播放器改播 `error.mp4`」，但那次观察**同时撞上了 412 风控**，所以**不能当作严格因果**。
   - 目前只能确定：当前这组属性在正常网络下没有已知问题。**改动前请先按第 2 条方法确认你的网络本身能播**，改完再复验。

4. **不做视频下载与转存**。所有视频都在 B 站官方播放器内播放，或点「原站打开」跳转。请遵守平台条款，仅个人学习使用。

5. **课程数据为人工核对的静态文件**（`public/data/courses.json`），按 B 站搜索页播放量排序挑选。播放量会变化，如需更新，替换该文件即可，不需要重启。

6. **当前 56 门课程全部来自 B 站**。国家中小学智慧教育平台的官方课程暂未纳入——该平台没有稳定的公开嵌入播放 ID，若后续需要，需按学科逐个确认课程页再补入 `courses.json`。

7. **学习码即凭证**。知道码的人就能读写该码的进度。这是「家庭内部使用」的定位；如果要暴露到公网，请在反向代理上加一层 Basic Auth 或 HTTPS + 访问控制。

## 八、扩科与加课

编辑 `public/data/courses.json`，往 `courses` 数组里加一条：

```json
{
  "id": "math-16",
  "subject": "math",
  "subjectName": "数学",
  "grade": "高二",
  "topic": "圆锥曲线",
  "title": "课程标题",
  "creator": "UP 主名",
  "platform": "bilibili",
  "platformName": "B 站",
  "bvid": "BV1xxxxxxxxx",
  "url": "https://www.bilibili.com/video/BV1xxxxxxxxx/",
  "embed": "https://player.bilibili.com/player.html?bvid=BV1xxxxxxxxx&high_quality=1&danmaku=0&autoplay=0",
  "play": 1200000,
  "playText": "120 万",
  "kind": "系列课",
  "tags": ["圆锥曲线"],
  "score": 9.0,
  "partCount": 1,
  "episodeDuration": 900,
  "totalDuration": 900,
  "parts": [{ "t": "第 1 集标题", "d": 900 }],
  "verifiedAt": "2026-11-21"
}
```

同时把 `subjects` 数组里对应学科的 `count` 加 1。若新增学科（如语文），再往 `subjects` 加一条并补 `grade` 之外的选项即可，前端会自动出现新筛选按钮。

加完课程后，跑一次 `node tools/update_courses.js`，脚本会自动补上 `cover`（B 站封面缩图）和 `reason`（推荐理由），并检查视频是否失效。这两项字段是可选的：没有封面时前端显示渐变色块，没有理由时显示学科与主题。若手工写好了推荐理由，设 `"reasonLocked": true`，脚本不会覆盖。

封面来自 B 站官方 CDN 并拼接 `@672w_378h_1c.webp` 现场缩图（约 120KB → 20KB）。图片带 `referrerpolicy="no-referrer"`，加载失败会自动移除、回退到渐变色块，不影响使用。

## 九、数据维护脚本

`tools/update_courses.js` 参考 BiliPicks 的维护思路，用 B 站公开接口（`x/web-interface/view`）只读地检查课程数据，零第三方依赖：

```bash
node tools/update_courses.js            # 刷新：补封面/理由、检测失效、刷新标题基线
node tools/update_courses.js --check    # 只出报告，不改文件
node tools/update_courses.js --deploy   # 刷新后 git 提交并推送
```

- **失效检测**：视频被删、不可见等，会标 `"dead": true`，前端自动隐藏；恢复可看后自动取消隐藏。
- **标题变化只提示、不覆盖**：本地标题是人工清洗过的短标题，和 B 站原标题天然不同。脚本首次运行记录基线，之后 B 站标题真的变了才提示，不会改动你写好的标题。
- **限流**：每个请求间隔 500ms，失败重试一次，不会给 B 站添麻烦。
- 这个脚本在你的电脑上运行即可，不需要在 armbian 小主机上跑。

## 十、目录说明

```
server.js                 后端：静态托管 + 学习码 + 进度同步（零依赖）
public/index.html         页面骨架
public/app.css            样式（含深色模式、移动端断点）
public/app.js             前端逻辑：筛选、分集播放、进度、家长视图
public/data/courses.json  课程库（56 门 / 2990 集，含封面与推荐理由）
tools/update_courses.js   数据维护脚本：查失效、补封面、生成推荐理由（本地运行）
.gitignore                忽略运行时数据与临时备份
```
