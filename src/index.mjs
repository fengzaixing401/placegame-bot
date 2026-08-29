import { loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { SecretBox } from "./crypto.mjs";
import { SettingsStore } from "./settings.mjs";
import { AccountStore } from "./accounts/store.mjs";
import { AccountService } from "./accounts/service.mjs";
import { fetchClientVersion } from "./version.mjs";
import { Scheduler } from "./scheduler.mjs";
import { createHttpServer } from "./http-server.mjs";
import { buildActions } from "./actions.mjs";

async function main() {
  const config = await loadConfig();
  const db = openDb(config.dbPath);
  const box = new SecretBox(config.masterKeyB64);
  const store = new AccountStore(db, box);

  // 生效令牌:库里轮换过就以库为准,否则用 env。两处都空则无人能进来,直接拒启。
  const settings = new SettingsStore(db, box, {
    envApiToken: config.apiToken,
    sessionHours: config.webSessionHours
  });
  if (!settings.apiToken) {
    throw new Error(
      "缺少 API 令牌:环境变量 PLACEGAME_API_TOKEN 为空且数据库中也没有。生成:node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\""
    );
  }
  console.log(`[init] API 令牌来源:${settings.apiTokenSource}`);
  if (!settings.webPasswordSet) {
    console.log("[init] WebUI 密码未设置,首次访问网页需用 Bearer 令牌完成初始设置");
  }

  // 版本闸门:客户端版本从服务端动态取,过低会被 426 拒绝。取不到就用兜底值继续起服务,
  // 让运维仍能通过 REST 管理账号,而不是整个服务起不来。
  let version = "0.0.0";
  try {
    const info = await fetchClientVersion();
    version = info.version;
    console.log(`[init] 客户端版本 ${version}`);
  } catch (err) {
    console.error(`[init] 获取客户端版本失败,暂用 ${version}:`, err.message);
  }

  const service = new AccountService({
    store,
    baseUrl: config.baseUrl,
    version,
    timeoutMs: config.requestTimeoutMs
  });

  const actions = buildActions(config);

  const scheduler = new Scheduler({ db, store, service, config, actions });
  if (config.schedulerEnabled) {
    scheduler.start();
    console.log(`[init] 排程已启用(时区 ${config.timezone})`);
  } else {
    console.log("[init] 排程已关闭(PLACEGAME_SCHEDULER=false),仅提供 REST");
  }

  const server = createHttpServer({ config, service, store, settings, scheduler, actions, version });
  server.listen(config.port, config.host, () => {
    console.log(`[init] REST 与 WebUI 监听 http://${config.host}:${config.port}`);
    console.log(`[init] 账号数 ${store.list().length},启用 ${store.list({ enabledOnly: true }).length}`);
  });

  const shutdown = (signal) => {
    console.log(`[exit] 收到 ${signal},正在关闭`);
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // 兜底:10s 内没优雅关完就强退,避免容器停不下来
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[fatal]", err.message);
  process.exit(1);
});
