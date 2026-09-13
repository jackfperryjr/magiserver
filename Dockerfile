# Magiloom server image: Ruby (Lich) + Node (gateway). Lich is cloned at build time.
#
# Ruby 4.0+ is required by Lich 5, and Ruby 4.x images ship on trixie, not bookworm —
# so this pins the base OS too. apt package names are unchanged on trixie.
FROM ruby:4.0-slim-trixie

# Node 20 + the C toolchain Lich's native gems (sqlite3, ffi) build against.
# The GTK/gobject-introspection headers are for Lich's gtk3 gem: Lich 5 preflights
# gtk3 unconditionally, even under --without-frontend.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git build-essential libsqlite3-dev libffi-dev \
      libssl-dev zlib1g-dev pkg-config libgtk-3-dev libgirepository1.0-dev \
      xvfb xauth \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Shared Lich engine --------------------------------------------------------
# Read-only base at /opt/lich; each user gets an isolated home seeded from it
# (src/lich-home.ts). MAGILOOM_LICH_SHARED lights up the "Connect with Lich" toggle.
#
# The gtk group is installed (only dev/vscode/profanity are skipped) because Lich
# also calls Gtk.init at startup with no headless bypass — hence xvfb above, which
# lich-manager.ts wraps the launch in. Without it: "failed to initialize GTK+".
#
# PINNED to a tag, and the pin IS the update mechanism here: `;lich5-update` can't
# work against a shared engine + per-user --home (its snapshot looks for
# <home>/lich.rbw, and its writes would split across two paths). Bump and redeploy
# instead — that moves lich.rbw and lib/ together. The tag is watched by
# .github/workflows/lich-update-check.yml, which opens a PR on a new release; only
# the tag token is machine-edited.
#
# 5.20.x: PR #1491 made room-id placement opt-in, defaulting DR to `line`. The
# automapper scrapes the id off the room TITLE (mapModel.ts parseRoomUid), so
# sessions need `;display roomid title` or room identity degrades to heuristics.
#
# A failed build does not take down the running deploy — Railway keeps the last good
# one until a new build succeeds.
RUN git clone --depth 1 --branch v5.21.0 https://github.com/elanthia-online/lich-5.git /opt/lich \
    && cd /opt/lich \
    && bundle lock --add-platform x86_64-linux \
    && bundle config set --local without 'development vscode profanity' \
    && bundle install
ENV MAGILOOM_LICH_SHARED=/opt/lich

# Want the ~237-script DR community library baked in too? Uncomment:
# RUN git clone --depth 1 https://github.com/elanthia-online/dr-scripts.git /tmp/dr \
#     && cp /tmp/dr/*.lic /opt/lich/scripts/ 2>/dev/null || true

WORKDIR /app
COPY package*.json ./
# Dev deps included so tsc is available for the build; pruned after.
RUN npm ci || npm install
COPY . .
RUN npm run build && npm prune --omit=dev

ENV MAGILOOM_DATA_DIR=/data
# Persist /data by attaching a Railway Volume mounted at /data. Railway ignores the
# Dockerfile VOLUME instruction, so it's omitted; without a volume /data is ephemeral.
EXPOSE 8787
CMD ["npm", "start"]
