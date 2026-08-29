# placegame-bot

PlaceGame 挂机游戏自动化服务。多账号、加密存凭据、定时排程，通过 REST 供 agent 操控。

零外部依赖，只用 Node 内置模块（SQLite 走 `node:sqlite`），所以多架构镜像无需编译原生模块。

## 快速开始

```bash
# 1. 生成两个密钥
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"  # 主密钥
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"  # API 令牌

# 2. 填 .env
cp .env.example .env

# 3. 启动
docker compose up -d

# 4. 加账号(凭据不写在配置里,POST 进去后加密存 SQLite)
curl -X POST http://127.0.0.1:18090/accounts \
  -H "authorization: Bearer $PLACEGAME_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"主号","gameUsername":"你的账号","password":"你的密码"}'

# 5. 验证能登录
curl -X POST http://127.0.0.1:18090/accounts/主号/verify \
  -H "authorization: Bearer $PLACEGAME_API_TOKEN"
```

`PLACEGAME_MASTER_KEY_B64` 丢失后已存账号无法解密，务必备份。

## WebUI

浏览器打开服务根路径即可。首次访问要求用 `.env` 里的 `PLACEGAME_API_TOKEN` 验证身份，
并设置一个至少 12 位的 WebUI 密码 —— 这样不必再往配置文件里塞第二个长期密码。
之后凭密码登录，可以管理账号、编辑规则、手动触发日常、查执行记录，以及：

- 改 WebUI 登录密码（需验旧密码，改完其他设备的登录状态立即作废）
- 改某个账号的游戏密码（改完该账号的游戏会话作废，下次动作用新密码重新登录）
- 轮换 API 令牌

### 操作要点两下：先看配置，再确定执行

点「地图首领」「背包分解」这类操作按钮**不会**立刻打游戏接口，只展开该操作自己的配置面板；
真正执行要按面板里的「确定执行」。面板里改的参数只作用于这一次，不动已存的规则；
想让排程也照这套参数跑，按面板里的「存为规则」。

因此**每个操作的参数都在它自己的面板里**（难度、首领名单、门票、胜率下限、分解条件……），
「规则设置」页只留跨操作的通用项：各任务间隔、世界首领时间窗、活动奖励领取时刻。

### 执行日志是中文句子，不是 JSON

执行记录展开后是逐行中文，例如「收下挂机收益：经验 128,400 · 金币 45,200 · 击杀 512」、
「分解 生锈短剑（green · 12 级 · 评分 340）」。原始 JSON 收在每条日志末尾的
「原始数据」里，默认折叠，排查异常时再展开。

渲染只认真实存在的字段：读不到就少写一行，不编造数值。所以某项没显示，
说明这次游戏返回里确实没有那个字段，而不是渲染漏了。

**轮换令牌的后果**：新令牌加密存库并立即生效，旧令牌当即 401。所有还在用旧令牌的 agent
必须同步更新，否则会一直失败。`.env` 里那个值从此不再生效但仍留在文件里，
若曾泄露请手动删除。生效值的来源可以从 `GET /health/ready` 的 `apiTokenSource` 看出
（`db` = 已轮换过，`env` = 还在用 `.env` 里的引导值）。

页面本身不含任何机密，数据全靠登录后的 XHR 取。会话 cookie 是 `HttpOnly` + `SameSite=Strict`，
写操作额外要求 `x-csrf-token` 头。密码用 scrypt 加盐存储，同一 IP 连续 5 次登录失败锁 15 分钟。

直连明文 HTTP 调试时需设 `PLACEGAME_WEB_SECURE_COOKIE=false`，否则浏览器不回传 cookie，登录会一直失败。

## 接口

账号可用 `label` 或 `id` 定位。除健康检查外都需要鉴权，两条路都认：
agent 用 `authorization: Bearer <令牌>`，浏览器用 WebUI 登录后的会话 cookie。
响应统一为 `{"ok":true,"data":...}` 或 `{"ok":false,"error":"..."}`。

### 健康检查（免鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health/live` | 进程存活 |
| GET | `/health/ready` | 含版本、账号数、排程状态、`apiTokenSource`、`webPasswordSet` |

### 账号管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/accounts` | 列出账号（不含任何凭据） |
| POST | `/accounts` | 新增，`{label, gameUsername, password, rules?}` |
| GET | `/accounts/:id` | 单个账号 |
| DELETE | `/accounts/:id` | 删除，需带 `{"confirm":true}` |
| POST | `/accounts/:id/enable` | 启用 |
| POST | `/accounts/:id/disable` | 停用，可带 `{reason}` |
| PUT | `/accounts/:id/rules` | 覆盖该号规则 |
| POST | `/accounts/:id/credentials` | 换凭据（旧会话立即作废） |
| POST | `/accounts/:id/verify` | 试登录 |

### 游戏动作

| 方法 | 路径 | 对应需求 |
|---|---|---|
| POST | `/accounts/:id/daily-run` | 一键全部日常（下列六项，逐项独立执行） |
| POST | `/accounts/:id/collect` | ① 收挂机收益（自动处理冒险选项） |
| POST | `/accounts/:id/inventory/decompose` | ② 背包一键分解 |
| POST | `/accounts/:id/profession/settle` | ③ 副职结算 + 排任务 |
| POST | `/accounts/:id/guild/daily` | ④ 公会兑换 + 捐献 + 分红 |
| POST | `/accounts/:id/boss/map` | ⑤ 按规则打地图/个人首领 |
| POST | `/accounts/:id/boss/world` | ⑤ 世界首领（窗口外自动跳过） |
| POST | `/accounts/:id/activity/claim-all` | ⑥ 领任务/成就/签到/邮件奖励 |
| POST | `/accounts/:id/map/change` | 切地图，`{mapKey}` |
| GET | `/accounts/:id/status` | 只读状态汇总 |

首领支持 `{"dryRun":true}` 只预览不执行。分解的 `dryRun` **只在 `explicit` 模式下可用**：
`auto` 模式走游戏自己的一键分解，没有对应的预览接口，传 `dryRun` 会直接报错而不是
假装预览、实际拆掉。

### 排程

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tasks` | 排程状态 + 最近 50 条执行记录 |
| GET | `/accounts/:id/tasks` | 该号执行记录 |
| POST | `/scheduler/tick` | 手动触发一轮 |

### WebUI 会话与设置

供页面自己调用。agent 用不上这几个，除了首次要用 Bearer 令牌完成初始设置。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/web/session` | 免 | 探测是否需要初始设置、当前是否已登录 |
| POST | `/api/web/setup` | 仅 Bearer | 设第一个 WebUI 密码，`{password}`；已设过返回 409 |
| POST | `/api/web/login` | 免 | `{password}`，成功下发会话 cookie 并返回 `csrfToken` |
| POST | `/api/web/logout` | 免 | 作废当前会话 |
| POST | `/api/web/password` | 会话 | `{currentPassword, newPassword}`，作废其他会话 |
| POST | `/api/web/api-token` | 会话 | `{currentPassword, token?}`，`token` 留空则随机生成 |

`/api/web/api-token` 的响应是新令牌明文唯一一次出现的地方，之后无法再读出。

### 错误码

`404` 账号或端点不存在 · `409` 账号已停用 · `413` 请求体过大 · `502` 游戏服务端出错 ·
`503` 客户端版本过低（游戏强制更新，需升 `version.mjs` 取到的版本）

## 排程规则

默认间隔按游戏机制定，时区固定 `Asia/Shanghai`（与容器 TZ 无关）：

- 收益 11 小时（挂机上限 12 小时，留 1 小时余量防溢出）
- 背包分解 11 小时 · 副职 6 小时 · 公会 20 小时
- 地图首领 2 小时（刷新间隔）
- 世界首领 10-11 / 16-17 / 20-21 点三个窗口
- 活动奖励每日 09:10

同一时间片重复触发靠 `job_runs` 的 UNIQUE 约束挡掉，重启或手动 tick 都不会重复执行。

每个账号可用 `PUT /accounts/:id/rules` **整体覆盖**规则树，结构与默认规则同形，数组整体替换。
注意这是覆盖不是合并：只想改一段的话，先 `GET /accounts/:id` 取回当前规则，改完再整棵传回去。
WebUI 的各处保存按钮都是这么做的。

页面上规则分两处，改哪儿取决于你要改什么：

- **「规则设置」页**：只有通用项 —— 各任务间隔、世界首领时间窗、活动奖励领取时刻。
- **各操作面板**：该操作自己的参数，按「存为规则」写进规则树的对应小节。

## 背包分解的条件

`inventory.mode` 两种：

- `auto` —— 调游戏自己的一键分解，条件由游戏决定，本程序不插手，也没法预览。
- `explicit` —— 本程序自己筛，逐件列出拆了什么、留下什么、为什么留。

`explicit` 模式下 `inventory.conditions` 可填：

| 字段 | 含义 |
|---|---|
| `maxScore` | 只拆评分**低于**此值的；读不到评分的一律留下 |
| `maxLevel` | 只拆装备等级**不高于**此值的 |
| `qualities` | 可分解品质白名单，不在名单里的留下 |
| `keepRareRank` | 带极品词条的一律留下。**默认就是开的**，只有显式写 `false` 才会连极品一起拆 |
| `keepAttrs` | 命中其中任一属性就留下 |

读不到评分或等级的装备，在设了对应条件时一律**留下**（原因写「读不到评分/等级」）——
条件判不了就不能拆，宁可漏拆不能误拆。

`keepRareRank` 不算收紧条件：它只保护极品，不限制其余任何一件，所以只勾它仍会被闸门拦下。

**`explicit` 模式至少要设一个收紧条件**（评分、等级或品质三者之一），否则整个背包都会命中，
所以后端直接拒绝、页面也会在发请求前拦下来。分解不可逆，这道闸门是故意设的。

**没填 ≠ 填 0。** 页面上清空一个数字框存进去是 `null`（没设这个条件）；
填 `0` 是真的「上限 0」，一件都筛不中，等于让这条排程永久空转。
这两者的区别在库里看得出来，别把 `null` 手写成 `0`。

范围只限**背包内且未上锁**的装备。已穿戴（`equipped`）、已上架（`on_market`）靠状态白名单排除；
真实服务端不返回「已装备」布尔字段，穿戴与否只体现在状态值上。服务端也没有仓库态 ——
官方 CLI 的标签表里那个 `in_warehouse` 在实测响应里并不存在。

## 首领挑战的几个约定

- **个人首领默认完全不碰。** 要打得先开 `boss.challengePersonal`，再把首领填进 `boss.personalBosses` —— 名单为空就一个都不打。`boss.mapBosses` 相反，空数组表示「全部可挑战的都打」。
- **挑战前先调预览。** `requirePredictedWin` 为真时预测会输就跳过；`minWinChance` 是胜率下限，预览拿不到胜率按不达标处理。设 `0` 才是不看胜率。
- **门票只能间接控制。** 接口没有门票开关，免费次数用尽后服务端会自动扣票。`useTickets` 为假时本程序在免费次数用尽后就停手，以此避免扣票。
- **难度取值不猜。** WebUI 会读游戏返回的可选难度渲染下拉；读不到就退化成文本框，此时只有 `normal` 是确认可用的。

## 公会捐献

规则里填的是物品的稳定标识 `itemKey`，运行时再去背包里解析成当次的实例 `itemId` —— 实例 ID 每次都变，写死会捐错东西。

## 安全

- 账号凭据 AES-GCM 加密后存 SQLite，AAD 绑定 `表:行:列`，密文无法跨行挪用
- 接口响应只返回 `publicView`，不含密文也不含明文
- 连续 5 次认证失败（15 分钟滑动窗口）自动停用账号，避免锁号
- API 令牌用常量时间比较
- 主密钥只从环境变量读，永不落库也不可改
- API 令牌轮换后加密存库；未轮换时用 `.env` 里的引导值
- WebUI 密码 scrypt 加盐存储；会话表只存令牌的 SHA-256，库泄露也无法复用会话
- 同一 IP 连续 5 次登录失败锁 15 分钟（按 IP 而非全局，免得有人把管理员锁在门外）
- 会话写操作要 `x-csrf-token`，与 `SameSite=Strict` 叠成两层
- 静态资源启动时按白名单读进内存，每请求不碰文件系统，路径穿越无从下手

公网暴露时至少要有 HTTPS 反代 + 足够长的 WebUI 密码。这个端口一旦上公网，
扫描器会持续探测登录页，密码强度是最后一道防线。

## 开发

```bash
npm test     # 端到端冒烟(假游戏服务器,不碰真实服务端)
npm run check # 语法检查
npm start
```
