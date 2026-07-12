# Magiloom server image: Ruby (Lich) + Node (gateway).
#
# The Ruby base carries Lich; Node.js is layered on for the gateway. Lich itself
# is CLONED from GitHub at build time (below) — nothing to upload by hand.
FROM ruby:3.4-slim-bookworm

# Node.js 20 + the C toolchain Lich's native gems (sqlite3, ffi) need to build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git build-essential libsqlite3-dev libffi-dev pkg-config \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Shared Lich engine --------------------------------------------------------
# Read-only base cloned into /opt/lich; each user gets an isolated home seeded
# from it (src/lich-home.ts). MAGILOOM_LICH_SHARED points the server at it, which
# lights up the "Connect with Lich" toggle. Lich runs headless in frostbite mode,
# so skip the GUI (gtk), dev and profanity gem groups. `bundle install` puts the
# gems on the system load path where lich.rbw's plain `require`s find them.
#
# NOTE: baking Lich here is still experimental — Lich has not been verified running
# headless on Linux in this setup. A failed build does NOT take down your running
# deploy (Railway keeps the last good one until a new build succeeds).
RUN git clone --depth 1 https://github.com/elanthia-online/lich-5.git /opt/lich \
    && cd /opt/lich \
    && bundle lock --add-platform x86_64-linux \
    && bundle config set --local without 'development vscode gtk profanity' \
    && bundle install
ENV MAGILOOM_LICH_SHARED=/opt/lich

# Want the ~237-script DR community library baked in too? Uncomment:
# RUN git clone --depth 1 https://github.com/elanthia-online/dr-scripts.git /tmp/dr \
#     && cp /tmp/dr/*.lic /opt/lich/scripts/ 2>/dev/null || true

WORKDIR /app
COPY package*.json ./
# Install all deps (incl. dev) so tsc is available for the build.
RUN npm ci || npm install
COPY . .
# Compile TypeScript, then drop dev deps to slim the runtime image.
RUN npm run build && npm prune --omit=dev

ENV MAGILOOM_DATA_DIR=/data
# Persist /data by attaching a Railway Volume with mount path /data in the
# service's settings. Railway ignores the Dockerfile VOLUME instruction, so it's
# intentionally omitted; without an attached volume /data is ephemeral.
EXPOSE 8787
CMD ["npm", "start"]
