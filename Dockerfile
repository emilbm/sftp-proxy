# syntax=docker/dockerfile:1

# One runtime dependency (ssh2). Its install script only builds an optional
# native crypto binding; skipping it leaves the pure-JS path, which needs no
# toolchain and builds the same way on amd64 and arm64.
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    WEB_PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY src/ ./src/

# Stamped by CI so a GlitchTip event says which build produced it.
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=$SENTRY_RELEASE

# Nothing is written locally - files stream straight from SFTP to the browser.
USER node
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so PID 1 is node and it receives SIGTERM directly.
CMD ["node", "src/index.js"]
