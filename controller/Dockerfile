FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git tar podman skopeo systemd dbus \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

CMD ["node", "dist/index.js"]
