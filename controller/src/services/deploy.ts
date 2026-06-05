import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
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

// ─── Quadlet ─────────────────────────────────────────────────────────────────

function writeAppQuadlet(app: AppConfig, imageName: string): void {
  const { runtimeEnv } = splitEnvVars(app.env ?? {});

  const envLines = Object.entries(runtimeEnv)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n');

  const volumeLines = (app.volumes ?? [])
    .map((v) => `Volume=${v}`)
    .join('\n');

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
    `HealthCmd=curl -f http://localhost:${app.port}/health || exit 1`,
    `HealthInterval=10s`,
    `HealthRetries=3`,
    `HealthTimeout=5s`,
    `HealthStartPeriod=30s`,
    ``,
    `Label=traefik.enable=true`,
    `Label=traefik.http.routers.${app.name}.rule=Host(\`${app.domain}\`)`,
    `Label=traefik.http.routers.${app.name}.entrypoints=websecure`,
    `Label=traefik.http.routers.${app.name}.tls.certresolver=letsencrypt`,
    `Label=traefik.http.services.${app.name}.loadbalancer.server.port=${app.port}`,
    `Label=traefik.http.services.${app.name}.loadbalancer.healthcheck.path=/health`,
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

    writeAppQuadlet(app, imageName);
    await stopAndRemoveContainer(app.name);
    await startAppContainer(app, imageName);

    log(`Deploy complete: ${app.name} @ ${imageName}`);
  } catch (err) {
    if (generatedDockerfile && fs.existsSync(dockerfilePath))
      fs.unlinkSync(dockerfilePath);
    throw err;
  }
}
