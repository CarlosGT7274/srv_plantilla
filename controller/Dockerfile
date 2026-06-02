FROM node:22-alpine

RUN apk add --no-cache curl git

# Pack CLI para buildpacks - detecta automaticamente cualquier lenguaje/package manager
RUN curl -sSL "https://github.com/buildpacks/pack/releases/download/v0.35.1/pack-v0.35.1-linux.tgz" \
    | tar -C /usr/local/bin/ --no-same-owner -xzv pack

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

CMD ["node", "dist/index.js"]
