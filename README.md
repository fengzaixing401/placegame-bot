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

## 接口

账号可用 `label` 或 `id` 定位。除健康检查外都需要 `authorization: Bearer <PLACEGAME_API_TOKEN>`。
响应统一为 `{"ok":true,"data":...}` 或 `{"ok":false,"error":"..."}`。

### 健康检查（免鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health/live` | 进程存活 |
| GET | `/health/ready` | 含版本、账号数、排程状态 |

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

分解与首领支持 `{"dryRun":true}` 只预览不执行。

### 排程

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/tasks` | 排程状态 + 最近 50 条执行记录 |
| GET | `/accounts/:id/tasks` | 该号执行记录 |
| POST | `/scheduler/tick` | 手动触发一轮 |

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

每个账号可用 `PUT /accounts/:id/rules` 覆盖，结构与默认规则同形，数组整体替换。

## 安全

- 账号凭据 AES-GCM 加密后存 SQLite，AAD 绑定 `表:行:列`，密文无法跨行挪用
- 接口响应只返回 `publicView`，不含密文也不含明文
- 连续 5 次认证失败（15 分钟滑动窗口）自动停用账号，避免锁号
- API 令牌用常量时间比较
- 主密钥与 API 令牌只从环境变量读，不落配置文件

## 开发

```bash
npm test     # 端到端冒烟(假游戏服务器,不碰真实服务端)
npm run check # 语法检查
npm start
```
