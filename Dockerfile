# 零外部依赖(只用 node: 内置模块,SQLite 走 node:sqlite),
# 所以不需要 npm ci、不需要编译原生模块,amd64/arm64 同一份构建即可。
FROM node:24-alpine

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PLACEGAME_HOST=0.0.0.0 \
    PLACEGAME_PORT=8080 \
    PLACEGAME_DB_PATH=/data/placegame.db

WORKDIR /app

COPY package.json ./
COPY src ./src

# 数据目录挂卷,容器重建不丢账号
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PLACEGAME_PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.mjs"]
