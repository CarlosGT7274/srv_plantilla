import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { request as httpRequest } from 'http';
import simpleGit from 'simple-git';
import { AppConfig } from '../types.js';
import {
  BUILDS_DIR,
  buildImageViaSock,
  splitEnvVars,
  stopAndRemoveContainer,
  startAppContainer,
  ensureUOption,
} from './podman.js';
import { buildWithCNB } from './cnb.js';
import { resolveIdentityFromLoadedImage } from './image-identity.js';
import { readDatabases } from '../config.js';
import { resolveLocalRef } from './refs.js';

const QUADLET_DIR = process.env.QUADLET_DIR || '/quadlets';

const inFlightDeploys = new Set<string>();

export function isDeployInProgress(name: string): boolean {
  return inFlightDeploys.has(name);
}

// ─── Git ─────────────────────────────────────────────────────────────────────

function buildCloneUrl(app: AppConfig): string {
  if (!app.private) return app.repo;
  const token = app.github_token || process.env.GITHUB_TOKEN || '';
  if (!token)
    throw new Error(`App "${app.name}" is private but no token is set`);
  return app.repo.replace('https://', `https://${token}@`);
}

async function cloneOrPull(app: AppConfig, buildPath: string): Promise<void> {
  const cloneUrl = buildCloneUrl(app);
  if (!fs.existsSync(buildPath)) {
    await simpleGit().clone(cloneUrl, buildPath);
  } else {
    await simpleGit(buildPath).remote(['set-url', 'origin', cloneUrl]);
    await simpleGit(buildPath).pull();
  }
}

// ─── Estrategia de build: Containerfile/Dockerfile vs CNB ───────────────────

function findContainerfile(buildPath: string): string | null {
  const dockerfile = path.join(buildPath, 'Dockerfile');
  const containerfile = path.join(buildPath, 'Containerfile');
  if (fs.existsSync(dockerfile)) return dockerfile;
  if (fs.existsSync(containerfile)) return containerfile;
  return null;
}

// ─── Health detection ─────────────────────────────────────────────────────────

function detectHealthCheckInCode(buildPath: string): string | null {
  try {
    const patterns = [
      "@Get('health')",
      "router.get('/health'",
      "app.get('/health'",
      "\"/health\"",
      "'/health'",
    ];

    for (const pattern of patterns) {
      try {
        execSync(`grep -rli "${pattern}" ${buildPath}/src ${buildPath}/app 2>/dev/null`);
        return '/health';
      } catch { }
    }
  } catch { }
  return null;
}

// ─── Health probe ─────────────────────────────────────────────────────────────

async function probeHealthEndpoint(
  app: AppConfig,
  log: (msg: string) => void,
  healthPath: string
): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000));

  const { status, data } = await podmanInspect(app.name);
  if (status !== 200) return;

  const info = data as {
    NetworkSettings?: {
      Networks?: Record<string, { IPAddress?: string }>;
    };
  };

  const ip = info.NetworkSettings?.Networks?.['proxy-net']?.IPAddress;
  if (!ip) return;

  const hasHealth = await new Promise<boolean>((resolve) => {
    const req = httpRequest(
      { host: ip, port: app.port, path: healthPath, method: 'GET' },
      (res) => resolve(res.statusCode === 200)
    );
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });

  if (hasHealth) {
    log(`✓  ${app.name}: ${healthPath} detected`);
  } else {
    log(`⚠  ${app.name}: no ${healthPath} endpoint found — add GET ${healthPath} returning 200 to enable Traefik health checks`);
  }
}

async function podmanInspect(name: string): Promise<{ status: number; data: unknown }> {
  const { podmanRequest } = await import('./podman.js');
  return podmanRequest('GET', `/v5.0.0/libpod/containers/${name}/json`);
}

// ─── Quadlet ─────────────────────────────────────────────────────────────────

function writeAppQuadlet(app: AppConfig, imageName: string, healthPath: string | null): void {
  const { runtimeEnv } = splitEnvVars(app.env ?? {});

  const envLines = Object.entries(runtimeEnv)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n');

  // Cada volumen recibe la opción `U` para que Podman ajuste el ownership
  // del mount contra la identidad real de la imagen al arrancar — sin que
  // este archivo necesite conocer ningún UID.
  const volumeLines = (app.volumes ?? [])
    .map((v) => `Volume=${ensureUOption(v)}`)
    .join('\n');

  const healthLines = healthPath ? [
    `HealthCmd=curl -f http://localhost:${app.port}${healthPath} || exit 1`,
    `HealthInterval=10s`,
    `HealthRetries=3`,
    `HealthTimeout=5s`,
    `HealthStartPeriod=30s`,
  ] : [];

  const traefikLabels = app.domain ? [
    `Label=traefik.enable=true`,
    `Label=traefik.http.routers.${app.name}.rule=Host(\`${app.domain}\`)`,
    `Label=traefik.http.routers.${app.name}.entrypoints=websecure`,
    `Label=traefik.http.routers.${app.name}.tls.certresolver=letsencrypt`,
    `Label=traefik.http.services.${app.name}.loadbalancer.server.port=${app.port}`,
    ...(healthPath ? [`Label=traefik.http.services.${app.name}.loadbalancer.healthcheck.path=${healthPath}`] : []),
  ] : [
    `PublishPort=127.0.0.1:${app.port + 1000}:${app.port}`
  ];

  const managedLabel = process.env.MANAGED_LABEL || 'servidor-jair.managed';

  // SIN `User=`. La identidad de ejecución la decide Podman a partir de
  // Config.User de la imagen, sin intervención de este controller.
  const content = [
    `[Unit]`,
    `Description=PaaS App ${app.name}`,
    `After=network-online.target`,
    ``,
    `[Container]`,
    `Image=${imageName}`,
    `ContainerName=${app.name}`,
    `Network=proxy-net`,
    `Label=${managedLabel}=true`,
    volumeLines,
    envLines,
    ``,
    ...healthLines,
    ``,
    ...traefikLabels,
    ``,
    `[Service]`,
    `Restart=always`,
    `RestartSec=5s`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
  ].join('\n').trim();

  fs.writeFileSync(path.join(QUADLET_DIR, `${app.name}.container`), content);
}

// ─── Main deploy ─────────────────────────────────────────────────────────────

export async function triggerDeploy(
  app: AppConfig,
  log: (msg: string) => void
): Promise<void> {
  if (inFlightDeploys.has(app.name)) {
    throw new Error(
      `Deploy para "${app.name}" ya está en curso — se ignora esta llamada en vez de correr en paralelo sobre el mismo workspace`
    );
  }
  inFlightDeploys.add(app.name);

  const buildPath = path.join(BUILDS_DIR, app.name);

  try {
    log(`Starting deploy for ${app.name}...`);

    const databases = readDatabases();
    const dbHost = app.env?.DATABASE_HOST || app.env?.DB_HOST;
    const dbRef = dbHost ? resolveLocalRef(dbHost) : null;
    const dbConfig = databases.find(d => d.name === dbHost);

    if (dbConfig && dbRef) {
      log(`🔗  Linking database: ${dbConfig.name}`);
      app.env = {
        ...app.env,
        DATABASE_USER: dbConfig.username || dbConfig.name,
        DB_USER: dbConfig.username || dbConfig.name,
        DATABASE_PASSWORD: dbConfig.password || 'changeme',
        DB_PASSWORD: dbConfig.password || 'changeme',
        DATABASE_NAME: dbConfig.database || dbConfig.name,
        DB_NAME: dbConfig.database || dbConfig.name,
        DATABASE_PORT: String(dbRef.internalPort),
        DB_PORT: String(dbRef.internalPort),
      };
    }

    await cloneOrPull(app, buildPath);

    let healthPath = app.health_path || null;
    if (app.health_check !== false && !healthPath) {
      healthPath = detectHealthCheckInCode(buildPath);
      if (healthPath) log(`🔍 Auto-detected health check at: ${healthPath}`);
      else log(`⚠  No health check detected in source code. Routing will be immediate.`);
    }

    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: buildPath,
    }).toString().trim();

    const imageName = `localhost/${app.name}:${commitHash}`;

    const containerfilePath = findContainerfile(buildPath);
    if (containerfilePath) {
      log(`Containerfile/Dockerfile detectado (${path.basename(containerfilePath)}) → build vía Podman/Buildah`);
      await buildImageViaSock(app, imageName, buildPath, log);
    } else {
      log(`Sin Containerfile/Dockerfile → build vía Cloud Native Buildpacks`);
      await buildWithCNB(app, imageName, buildPath, log);
    }

    // ─── Identidad de la imagen final: solo para auditoría/log ────────────
    // No se usa para forzar ningún `User=`. Si el build hizo su trabajo
    // correctamente (ver cnb.ts), Podman ya va a arrancar el contenedor
    // con esta misma identidad sin que este archivo intervenga.
    try {
      const identity = await resolveIdentityFromLoadedImage(imageName);
      log(
        `Identidad declarada por la imagen: user="${identity.user || '(root/no declarado)'}"` +
        (identity.workingDir ? `, workdir=${identity.workingDir}` : '')
      );
    } catch (err) {
      log(`⚠  No se pudo auditar la identidad de la imagen: ${(err as Error).message}`);
    }

    writeAppQuadlet(app, imageName, healthPath);
    await stopAndRemoveContainer(app.name);
    await startAppContainer(app, imageName, healthPath);

    if (healthPath) {
      log(`Probing ${healthPath} endpoint on ${app.name}...`);
      probeHealthEndpoint(app, log, healthPath).catch(() => { });
    }

    log(`Deploy complete: ${app.name} @ ${imageName}`);
  } finally {
    inFlightDeploys.delete(app.name);
  }
}
