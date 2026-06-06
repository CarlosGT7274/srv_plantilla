import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { request as httpRequest } from 'http';
import simpleGit from 'simple-git';
import { AppConfig } from '../types.js';
import { BUILDS_DIR, buildImageViaSock, splitEnvVars, stopAndRemoveContainer, startAppContainer } from './podman.js';
import { detectProject, generateDockerfile } from './dockerfile.js';

const QUADLET_DIR = process.env.QUADLET_DIR || '/quadlets';

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
        // Buscamos en src o app, redirigiendo errores para que no rompa el flujo
        execSync(`grep -rli "${pattern}" ${buildPath}/src ${buildPath}/app 2>/dev/null`);
        return '/health';
      } catch { }
    }
  } catch { }
  return null;
}

// ─── Health probe ─────────────────────────────────────────────────────────────
// Purely informational — result does NOT affect whether the label is applied.
// Traefik always gets the healthcheck label; this probe just warns the developer
// if the app doesn't implement GET /health yet.

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

  const volumeLines = (app.volumes ?? [])
    .map((v) => `Volume=${v}`)
    .join('\n');

  const healthLines = healthPath ? [
    `HealthCmd=curl -f http://localhost:${app.port}${healthPath} || exit 1`,
    `HealthInterval=10s`,
    `HealthRetries=3`,
    `HealthTimeout=5s`,
    `HealthStartPeriod=30s`,
  ] : [];

  const traefikHealthLabel = healthPath
    ? [`Label=traefik.http.services.${app.name}.loadbalancer.healthcheck.path=${healthPath}`]
    : [];

  const content = [
    `[Unit]`,
    `Description=PaaS App ${app.name}`,
    `After=network-online.target`,
    ``,
    `[Container]`,
    `Image=${imageName}`,
    `ContainerName=${app.name}`,
    `Network=proxy-net`,
    volumeLines,
    envLines,
    ``,
    ...healthLines,
    ``,
    `Label=traefik.enable=true`,
    `Label=traefik.http.routers.${app.name}.rule=Host(\`${app.domain}\`)`,
    `Label=traefik.http.routers.${app.name}.entrypoints=websecure`,
    `Label=traefik.http.routers.${app.name}.tls.certresolver=letsencrypt`,
    `Label=traefik.http.services.${app.name}.loadbalancer.server.port=${app.port}`,
    ...traefikHealthLabel,
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
  const buildPath = path.join(BUILDS_DIR, app.name);
  const dockerfilePath = path.join(buildPath, 'Dockerfile');
  let generatedDockerfile = false;

  try {
    log(`Starting deploy for ${app.name}...`);

    await cloneOrPull(app, buildPath);

    // ✅ Detectar si hay health check en el código
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

    if (!fs.existsSync(dockerfilePath)) {
      const type = detectProject(buildPath);
      log(`Detected project type: ${type}`);
      fs.writeFileSync(dockerfilePath, generateDockerfile(type, app.port));
      generatedDockerfile = true;
    } else {
      log(`Using existing Dockerfile`);
    }

    await buildImageViaSock(app, imageName, buildPath, log);

    if (generatedDockerfile && fs.existsSync(dockerfilePath))
      fs.unlinkSync(dockerfilePath);

    writeAppQuadlet(app, imageName, healthPath);
    await stopAndRemoveContainer(app.name);
    await startAppContainer(app, imageName, healthPath);

    if (healthPath) {
      log(`Probing ${healthPath} endpoint on ${app.name}...`);
      probeHealthEndpoint(app, log, healthPath).catch(() => { });
    }

    log(`Deploy complete: ${app.name} @ ${imageName}`);
  } catch (err) {
    if (generatedDockerfile && fs.existsSync(dockerfilePath))
      fs.unlinkSync(dockerfilePath);
    throw err;
  }
}
