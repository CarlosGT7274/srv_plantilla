FROM node:22-alpine

# Solo necesitamos curl (healthcheck) y git (clonar repos).
# NO necesitamos podman ni buildah — el build de imágenes se hace
# via la REST API del socket de Podman del host directamente.
RUN apk add --no-cache curl git tar

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

CMD ["node", "dist/index.js"]
