import { loadConfig } from "./config.mjs";
import { openDb } from "./db.mjs";
import { SecretBox } from "./crypto.mjs";
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

  const server = createHttpServer({ config, service, store, scheduler, actions, version });
  server.listen(config.port, config.host, () => {
    console.log(`[init] REST 监听 http://${config.host}:${config.port}(需 Bearer 令牌)`);
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
