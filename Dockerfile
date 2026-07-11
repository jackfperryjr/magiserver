# Magiloom server image: Node (gateway) + Ruby (Lich). Railway can build this
# directly. Lich is optional — omit the Ruby layers if you only ever direct-connect.
FROM node:20-bookworm-slim

# Ruby for Lich. Lich 5 needs Ruby + a few gems (sqlite3, gtk is NOT needed in
# --without-frontend / frostbite headless mode).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ruby ruby-dev build-essential libsqlite3-dev git ca-certificates \
    && gem install sqlite3 --no-document \
    && rm -rf /var/lib/apt/lists/*

# --- Lich install (optional) ---------------------------------------------------
# Bake the shared, read-only Lich install here; each user gets an isolated home
# seeded from it (src/lich-home.ts symlinks the community script library in).
# MAGILOOM_LICH_SHARED points the server at it. Omit this + the env var to run
# direct-connect only (no Lich).
# RUN git clone --depth 1 https://github.com/elanthia-online/lich-5.git /opt/lich
# ENV MAGILOOM_LICH_SHARED=/opt/lich

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN npm run build

ENV MAGILOOM_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
CMD ["npm", "start"]
