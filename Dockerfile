ARG PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ------------------------------
# Base - 安装生产依赖和 Playwright 系统依赖
# ------------------------------
FROM node:22-bookworm-slim AS base

ARG PLAYWRIGHT_BROWSERS_PATH
ENV PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}

WORKDIR /app

# 使用传统 COPY 方式（兼容 Railway 构建环境）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npx -y playwright-core install-deps chromium

# ------------------------------
# Builder - 安装完整 dev 依赖（用于构建）
# ------------------------------
FROM base AS builder

# 安装完整依赖
RUN npm ci
# 复制源码
COPY *.json *.js ./

# ------------------------------
# Browser - 安装 Chromium 浏览器
# ------------------------------
FROM base AS browser

RUN npx -y playwright-core install --no-shell chromium

# ------------------------------
# Runtime - 最终运行镜像
# ------------------------------
FROM base

ARG PLAYWRIGHT_BROWSERS_PATH
ARG USERNAME=node
ENV NODE_ENV=production

# 从 browser 阶段复制 Chromium
COPY --from=browser ${PLAYWRIGHT_BROWSERS_PATH} ${PLAYWRIGHT_BROWSERS_PATH}
# 复制 cli.js 和 package.json
COPY cli.js package.json ./

# 修复权限
RUN chown -R ${USERNAME}:${USERNAME} node_modules /app

EXPOSE 3000

USER ${USERNAME}

WORKDIR /home/${USERNAME}

ENTRYPOINT ["node", "/app/cli.js", "--headless", "--browser", "chromium", "--no-sandbox", "--host", "0.0.0.0", "--port", "3000", "--allowed-hosts", "*"]
