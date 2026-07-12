FROM node:22-alpine

# curl/git/tar: ya existían (healthcheck, clonar repos, tarball builds).
# podman: CLI en modo remoto contra CONTAINER_HOST (socket del host) —
#         usado por cnb.ts para correr las fases del lifecycle y podman load.
# skopeo: conversión OCI-layout -> docker-archive (operación local, sin
#         tocar storage de nadie) antes del podman load.
RUN apk add --no-cache curl git tar podman skopeo

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

CMD ["node", "dist/index.js"]
