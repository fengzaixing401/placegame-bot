#!/usr/bin/env bash
# 本地起一份一次性实例,只为在浏览器里验证 WebUI。
# 密钥当场生成、只存在于本进程环境变量里,不写盘、不回显。
set -euo pipefail
cd "$(dirname "$0")/.."

rm -f data/webtest.db data/webtest.db-wal data/webtest.db-shm

export PLACEGAME_MASTER_KEY_B64="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PLACEGAME_API_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PLACEGAME_DB_PATH="data/webtest.db"
export PLACEGAME_SCHEDULER=false
# 明文 HTTP 调试:带 Secure 的 cookie 浏览器不回传,登录会一直失败
export PLACEGAME_WEB_SECURE_COOKIE=false
export PLACEGAME_HOST=127.0.0.1
export PLACEGAME_PORT=18099
# 指向不存在的端口:游戏调用立即失败,正好验证 /options 取不到数据时的降级渲染
export PLACEGAME_BASE_URL="http://127.0.0.1:1"
export PLACEGAME_REQUEST_TIMEOUT_MS=1500

# 令牌单独写一份给测试脚本读,权限 600,退出时删
umask 077
printf '%s' "$PLACEGAME_API_TOKEN" > data/webtest.token
trap 'rm -f data/webtest.token' EXIT INT TERM

# 不用 exec:exec 会顶掉本 shell,trap 就没机会跑,令牌明文会留在盘上
node src/index.mjs
