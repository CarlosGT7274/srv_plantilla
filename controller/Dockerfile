FROM node:22-alpine

RUN apk add --no-cache curl git buildah fuse-overlayfs

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

CMD ["node", "dist/index.js"]
