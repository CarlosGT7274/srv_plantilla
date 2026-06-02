import Fastify from 'fastify';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { request as httpRequest } from 'http';
import simpleGit from 'simple-git';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const GITHUB_SECRET = process.env.GITHUB_SECRET || '';
const CONFIG_PATH = process.env.CONFIG_PATH || './config/apps.json';
const BUILDS_DIR = process.env.BUILDS_DIR || './builds';
const QUADLET_DIR = process.env.QUADLET_DIR || '/quadlets';
const PODMAN_SOCK = process.env.CONTAINER_HOST?.replace('unix://', '') ||
  `/run/user/1000/podman/podman.sock`;

const fastify = Fastify({ logger: true });

interface AppConfig {
  name: string;
  repo: string;
  domain: string;
  port: number;
  private?: boolean;
  github_token?: string;
  env?: Record<string, string>;
  volumes?: string[];
}

// ── Project type detection ─────────────────────────────────────────────────

type ProjectType = 'node-npm' | 'node-pnpm' | 'node-yarn' | 'node-bun' |
  'python-pip' | 'python-poetry' | 'java-maven' |
  'java-gradle' | 'go' | 'ruby' | 'unknown';

function detectProject(buildPath: string): ProjectType {
  const has = (f: string) => fs.existsSync(path.join(buildPath, f));

  if (has('pnpm-lock.yaml') || has('.pnpmfile.cjs')) return 'node-pnpm';
  if (has('yarn.lock')) return 'node-yarn';
  if (has('bun.lockb')) return 'node-bun';
  if (has('package.json')) return 'node-npm';
  if (has('pyproject.toml')) return 'python-poetry';
  if (has('requirements.txt')) return 'python-pip';
  if (has('pom.xml')) return 'java-maven';
  if (has('build.gradle') || has('build.gradle.kts')) return 'java-gradle';
  if (has('go.mod')) return 'go';
  if (has('Gemfile')) return 'ruby';
  return 'unknown';
}

function generateDockerfile(type: ProjectType, port: number): string {
  switch (type) {
    case 'node-npm':
      return `
FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build --if-present
EXPOSE ${port}
CMD ["npm", "start"]
`.trim();

    case 'node-pnpm':
      return `
FROM node:22-alpine
RUN apk add --no-cache curl && npm install -g pnpm
WORKDIR /app
COPY package*.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build --if-present
EXPOSE ${port}
CMD ["pnpm", "start"]
`.trim();

    case 'node-yarn':
      return `
FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build --if-present
EXPOSE ${port}
CMD ["yarn", "start"]
`.trim();

    case 'node-bun':
      return `
FROM oven/bun:latest
WORKDIR /app
COPY bun.lockb package.json ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build --if-present
EXPOSE ${port}
CMD ["bun", "start"]
`.trim();

    case 'python-pip':
      return `
FROM python:3.12-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${port}
CMD ["python", "main.py"]
`.trim();

    case 'python-poetry':
      return `
FROM python:3.12-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN pip install poetry
WORKDIR /app
COPY pyproject.toml poetry.lock* ./
RUN poetry install --no-root --no-dev
COPY . .
EXPOSE ${port}
CMD ["poetry", "run", "python", "main.py"]
`.trim();

    case 'java-maven':
      return `
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml ./
COPY src ./src
RUN mvn package -DskipTests

FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]
`.trim();

    case 'java-gradle':
      return `
FROM gradle:8-jdk21 AS build
WORKDIR /app
COPY . .
RUN gradle build -x test

FROM eclipse-temurin:21-jre-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]
`.trim();

    case 'go':
      return `
FROM golang:1.22-alpine AS build
RUN apk add --no-cache curl
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o server .

FROM alpine:latest
RUN apk add --no-cache curl ca-certificates
WORKDIR /app
COPY --from=build /app/server .
EXPOSE ${port}
CMD ["./server"]
`.trim();

    case 'ruby':
      return `
FROM ruby:3.3-alpine
RUN apk add --no-cache curl build-base
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install
COPY . .
EXPOSE ${port}
CMD ["ruby", "app.rb"]
`.trim();

    default:
      throw new Error('Could not detect project type. Supported: Node (npm/pnpm/yarn/bun), Python (pip/poetry), Java (Maven/Gradle), Go, Ruby.');
  }
}

// ── Podman socket helpers ──────────────────────────────────────────────────

function podmanRequest(
  method: string,
  urlPath: string,
  body?: object
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        socketPath: PODMAN_SOCK,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function containerExists(name: string): Promise<boolean> {
  const { status } = await podmanRequest('GET', `/v4.0.0/libpod/containers/${name}/json`);
  return status === 200;
}

async function stopAndRemoveContainer(name: string): Promise<void> {
  if (!(await containerExists(name))) return;
  fastify.log.info(`Stopping container ${name}...`);
  await podmanRequest('POST', `/v4.0.0/libpod/containers/${name}/stop`);
  fastify.log.info(`Removing container ${name}...`);
  await podmanRequest('DELETE', `/v4.0.0/libpod/containers/${name}?force=true`);
}

async function startContainer(app: AppConfig, imageName: string): Promise<void> {
  fastify.log.info(`Creating container ${app.name} from ${imageName}...`);

  const body = {
    name: app.name,
    image: imageName,
    env: Object.entries(app.env ?? {}).map(([k, v]) => `${k}=${v}`),
    networks: { 'proxy-net': {} },
    labels: {
      'traefik.enable': 'true',
      [`traefik.http.routers.${app.name}.rule`]: `Host(\`${app.domain}\`)`,
      [`traefik.http.routers.${app.name}.entrypoints`]: 'websecure',
      [`traefik.http.routers.${app.name}.tls.certresolver`]: 'letsencrypt',
      [`traefik.http.services.${app.name}.loadbalancer.server.port`]: String(app.port),
      [`traefik.http.services.${app.name}.loadbalancer.healthcheck.path`]: '/health',
    },
    healthconfig: {
      test: ['CMD-SHELL', `curl -f http://localhost:${app.port}/health || exit 1`],
      interval: 10_000_000_000,
      timeout: 5_000_000_000,
      retries: 3,
      start_period: 30_000_000_000,
    },
    restart_policy: { name: 'always' },
    mounts: (app.volumes ?? []).map((v) => {
      const [src, dst, ...opts] = v.split(':');
      return { type: 'bind', source: src, destination: dst, options: opts };
    }),
  };

  const { status, data } = await podmanRequest('POST', '/v4.0.0/libpod/containers/create', body);
  if (status !== 201) throw new Error(`Failed to create container: ${JSON.stringify(data)}`);

  const { status: s, data: d } = await podmanRequest('POST', `/v4.0.0/libpod/containers/${app.name}/start`);
  if (s !== 204) throw new Error(`Failed to start container: ${JSON.stringify(d)}`);

  fastify.log.info(`Container ${app.name} started.`);
}

// ── Clone / pull ───────────────────────────────────────────────────────────

function buildCloneUrl(app: AppConfig): string {
  if (!app.private) return app.repo;
  const token = app.github_token || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error(`App "${app.name}" is private but no token is set`);
  return app.repo.replace('https://', `https://${token}@`);
}

async function cloneOrPull(app: AppConfig, buildPath: string): Promise<void> {
  const cloneUrl = buildCloneUrl(app);
  const git = simpleGit();
  if (!fs.existsSync(buildPath)) {
    fastify.log.info(`Cloning ${app.repo}...`);
    await git.clone(cloneUrl, buildPath);
  } else {
    fastify.log.info(`Pulling latest for ${app.name}...`);
    await simpleGit(buildPath).remote(['set-url', 'origin', cloneUrl]);
    await simpleGit(buildPath).pull();
  }
}

// ── Quadlet writer ─────────────────────────────────────────────────────────

function writeQuadlet(app: AppConfig, imageName: string): void {
  const content = `\
[Unit]
Description=PaaS App ${app.name}
After=network-online.target

[Container]
Image=${imageName}
ContainerName=${app.name}
Network=proxy-net
${(app.volumes ?? []).map(v => `Volume=${v}`).join('\n')}
${Object.entries(app.env ?? {}).map(([k, v]) => `Environment=${k}=${v}`).join('\n')}

HealthCmd=curl -f http://localhost:${app.port}/health || exit 1
HealthInterval=10s
HealthRetries=3
HealthTimeout=5s
HealthStartPeriod=30s

Label=traefik.enable=true
Label=traefik.http.routers.${app.name}.rule=Host(\`${app.domain}\`)
Label=traefik.http.routers.${app.name}.entrypoints=websecure
Label=traefik.http.routers.${app.name}.tls.certresolver=letsencrypt
Label=traefik.http.services.${app.name}.loadbalancer.server.port=${app.port}
Label=traefik.http.services.${app.name}.loadbalancer.healthcheck.path=/health

[Service]
Restart=always
RestartSec=5s

[Install]
WantedBy=default.target
`.trim();

  fs.writeFileSync(path.join(QUADLET_DIR, `${app.name}.container`), content);
  fastify.log.info(`Quadlet written for ${app.name}`);
}

// ── Signature verification ─────────────────────────────────────────────────

function verifySignature(payload: string, signature: string): boolean {
  const hmac = crypto.createHmac('sha256', GITHUB_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
}

// ── Deploy logic ───────────────────────────────────────────────────────────

async function triggerDeploy(app: AppConfig): Promise<void> {
  try {
    fastify.log.info(`Starting deploy for ${app.name}...`);

    const buildPath = path.join(BUILDS_DIR, app.name);
    await cloneOrPull(app, buildPath);

    const commitHash = execSync('git rev-parse --short HEAD', { cwd: buildPath }).toString().trim();
    const imageName = `localhost/${app.name}:${commitHash}`;

    // Si ya existe Dockerfile en el repo lo usa, si no genera uno automaticamente
    const dockerfilePath = path.join(buildPath, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) {
      const type = detectProject(buildPath);
      fastify.log.info(`Detected project type: ${type}`);
      const dockerfile = generateDockerfile(type, app.port);
      fs.writeFileSync(dockerfilePath, dockerfile);
      fastify.log.info(`Generated Dockerfile for ${type}`);
    } else {
      fastify.log.info(`Using existing Dockerfile`);
    }

    fastify.log.info(`Building image: ${imageName}`);
    execSync(
      `buildah build --isolation=chroot -t ${imageName} .`,
      { cwd: buildPath, stdio: 'inherit' }
    );

    // Limpia el Dockerfile generado para no ensuciarlo repo
    const generatedDockerfile = path.join(buildPath, 'Dockerfile');
    if (fs.existsSync(generatedDockerfile)) {
      fs.unlinkSync(generatedDockerfile);
    }

    writeQuadlet(app, imageName);
    await stopAndRemoveContainer(app.name);
    await startContainer(app, imageName);

    fastify.log.info(`Deploy complete: ${app.name} @ ${imageName}`);
  } catch (err) {
    const error = err as Error;
    fastify.log.error(`Deploy failed for ${app.name}: ${error.message}`);
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.get('/apps', async () => {
  const config: AppConfig[] = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return config.map((a) => ({
    name: a.name,
    domain: a.domain,
    port: a.port,
    private: a.private ?? false,
    repo: a.repo,
  }));
});

fastify.post('/deploy/:name', async (request, reply) => {
  const { name } = request.params as { name: string };
  const config: AppConfig[] = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const app = config.find((a) => a.name === name);
  if (!app) return reply.status(404).send({ error: `App "${name}" not found` });
  reply.send({ message: 'Deploy started', app: app.name });
  triggerDeploy(app);
});

fastify.post('/webhook', async (request, reply) => {
  const signature = request.headers['x-hub-signature-256'] as string;
  if (!signature || !verifySignature(JSON.stringify(request.body), signature)) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }
  const payload = request.body as { repository: { clone_url: string } };
  const config: AppConfig[] = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const app = config.find((a) => a.repo === payload.repository.clone_url);
  if (!app) return reply.send({ message: 'Repo not managed' });
  reply.send({ message: 'Deploy started', app: app.name });
  triggerDeploy(app);
});

// ── Start ──────────────────────────────────────────────────────────────────

fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
