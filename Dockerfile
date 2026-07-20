# Magiloom server image: Ruby (Lich) + Node (gateway).
#
# The Ruby base carries Lich; Node.js is layered on for the gateway. Lich itself
# is CLONED from GitHub at build time (below) — nothing to upload by hand.
#
# Ruby 4.0+ is required by current Lich 5 (older Ruby aborts at startup with
# "Your version … of Ruby is too old"). Ruby 4.x images are published on Debian
# trixie (13), not bookworm (12) — there is no 4.x-slim-bookworm — so this is also
# a base-OS bump; the apt package names below are unchanged on trixie.
FROM ruby:4.0-slim-trixie

# Node.js 20 + the C toolchain Lich's native gems (sqlite3, ffi) need to build.
# The libgtk-3-dev + libgirepository1.0-dev stack is for Lich's gtk3 gem: current
# Lich 5 checks for gtk3 at startup UNCONDITIONALLY (even --without-frontend, which
# only stops it opening a window, doesn't skip the gem preflight), so the gem must
# be installable — which needs the GTK/GObject-introspection dev headers. libgtk-3-dev
# pulls the glib/cairo/pango/gdk-pixbuf -dev deps the ruby-gnome chain builds against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git build-essential libsqlite3-dev libffi-dev \
      libssl-dev zlib1g-dev pkg-config libgtk-3-dev libgirepository1.0-dev \
      xvfb xauth \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Shared Lich engine --------------------------------------------------------
# Read-only base cloned into /opt/lich; each user gets an isolated home seeded
# from it (src/lich-home.ts). MAGILOOM_LICH_SHARED points the server at it, which
# lights up the "Connect with Lich" toggle. `bundle install` puts the gems on the
# system load path where lich.rbw's plain `require`s find them.
#
# The gtk group IS installed (only dev/vscode/profanity are skipped): current Lich 5
# (5.19) both requires the gtk3 gem AND calls Gtk.init at startup unconditionally —
# there is no headless/without-frontend bypass — so it needs a real X display too.
# The GTK dev headers above let the gem build; the xvfb/xauth packages above provide
# the throwaway virtual display Gtk.init needs (Lich is launched under xvfb-run — see
# lib/lich-manager.ts). Without it Lich aborts with "failed to initialize GTK+".
#
# NOTE: baking Lich here is still experimental. A failed build does NOT take down your
# running deploy (Railway keeps the last good one until a new build succeeds).
RUN git clone --depth 1 https://github.com/elanthia-online/lich-5.git /opt/lich \
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
