import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppConfig } from '../types.js';

const execFileAsync = promisify(execFile);

export const PODMAN_SOCK =
  process.env.CONTAINER_HOST?.replace('unix://', '') ||
  `/run/user/1000/podman/podman.sock`;

export const BUILDS_DIR = process.env.BUILDS_DIR || './builds';

// ─── Core HTTP over Unix socket ──────────────────────────────────────────────

export function podmanRequest(
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

// ─── Container lifecycle ─────────────────────────────────────────────────────

export async function containerExists(name: string): Promise<boolean> {
  const { status } = await podmanRequest(
    'GET',
    `/v5.0.0/libpod/containers/${name}/json`
  );
  return status === 200;
}

export async function stopAndRemoveContainer(name: string): Promise<void> {
  if (!(await containerExists(name))) return;
  await podmanRequest('POST', `/v5.0.0/libpod/containers/${name}/stop`);
  await podmanRequest('DELETE', `/v5.0.0/libpod/containers/${name}?force=true`);
}

export async function startAppContainer(
  app: AppConfig,
  imageName: string,
  healthPath: string | null
): Promise<void> {
  const { runtimeEnv } = splitEnvVars(app.env ?? {});

  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    [`traefik.http.routers.${app.name}.rule`]: `Host(\`${app.domain}\`)`,
    [`traefik.http.routers.${app.name}.entrypoints`]: 'websecure',
    [`traefik.http.routers.${app.name}.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.services.${app.name}.loadbalancer.server.port`]: String(app.port),
  };

  if (healthPath) {
    labels[`traefik.http.services.${app.name}.loadbalancer.healthcheck.path`] = healthPath;
  }

  const body: any = {
    name: app.name,
    image: imageName,
    env: runtimeEnv,
    Networks: { 'proxy-net': { aliases: [app.name] } },
    Labels: labels,
    netns: { nsmode: 'bridge' },
    restart_policy: 'always',
    mounts: (app.volumes ?? []).map((v) => {
      const [src, dst, ...opts] = v.split(':');
      return { type: 'bind', source: src, destination: dst, options: opts };
    }),
  };

  if (healthPath) {
    body.healthconfig = {
      test: ['CMD-SHELL', `curl -f http://localhost:${app.port}${healthPath} || exit 1`],
      interval: 10_000_000_000,
      timeout: 5_000_000_000,
      retries: 3,
      start_period: 30_000_000_000,
    };
  }

  const { status, data } = await podmanRequest(
    'POST',
    '/v5.0.0/libpod/containers/create',
    body
  );
  if (status !== 201)
    throw new Error(`Failed to create container: ${JSON.stringify(data)}`);

  const { status: s, data: d } = await podmanRequest(
    'POST',
    `/v5.0.0/libpod/containers/${app.name}/start`
  );
  if (s !== 204)
    throw new Error(`Failed to start container: ${JSON.stringify(d)}`);
}

export async function startDatabaseContainer(
  name: string,
  image: string,
  env: Record<string, string>,
  dataDir: string,
  hostDataDir: string
): Promise<void> {
  const body = {
    name,
    image,
    env,
    Networks: { 'proxy-net': { aliases: [name] } },
    netns: { nsmode: 'bridge' },
    restart_policy: 'always',
    mounts: [
      {
        type: 'bind',
        source: hostDataDir,
        destination: dataDir,
        options: ['z'],
      },
    ],
  };

  const { status, data } = await podmanRequest(
    'POST',
    '/v5.0.0/libpod/containers/create',
    body
  );
  if (status !== 201)
    throw new Error(`Failed to create DB container: ${JSON.stringify(data)}`);

  const { status: s, data: d } = await podmanRequest(
    'POST',
    `/v5.0.0/libpod/containers/${name}/start`
  );
  if (s !== 204)
    throw new Error(`Failed to start DB container: ${JSON.stringify(d)}`);
}

// ─── Image build ─────────────────────────────────────────────────────────────

const BUILD_TIME_PATTERNS = [
  /^NEXT_PUBLIC_/, /^VITE_/, /^REACT_APP_/,
  /^NUXT_PUBLIC_/, /^PUBLIC_/, /^GATSBY_/,
];

export function splitEnvVars(env: Record<string, string>): {
  buildEnv: Record<string, string>;
  runtimeEnv: Record<string, string>;
} {
  const buildEnv: Record<string, string> = {};
  const runtimeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (BUILD_TIME_PATTERNS.some((p) => p.test(k))) buildEnv[k] = v;
    else runtimeEnv[k] = v;
  }
  return { buildEnv, runtimeEnv };
}

export async function buildImageViaSock(
  app: AppConfig,
  imageName: string,
  buildPath: string,
  log: (msg: string) => void
): Promise<void> {
  const { buildEnv } = splitEnvVars(app.env ?? {});
  const dockerfilePath = path.join(buildPath, 'Dockerfile');
  const tarPath = path.join(BUILDS_DIR, `${path.basename(buildPath)}.tar`);
  let originalDockerfile: string | null = null;

  try {
    if (Object.keys(buildEnv).length > 0 && fs.existsSync(dockerfilePath)) {
      originalDockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
      const argBlock = Object.keys(buildEnv)
        .map((k) => `ARG ${k}\nENV ${k}=$${k}`)
        .join('\n');
      fs.writeFileSync(
        dockerfilePath,
        originalDockerfile.replace(/^(FROM\s+\S[^\n]*)$/m, `$1\n${argBlock}`)
      );
    }

    log(`Tarballing build context at ${buildPath}...`);
    await execFileAsync('tar', [
      '-C', buildPath,
      '--exclude=.git', '--exclude=node_modules',
      '--exclude=.next', '--exclude=dist',
      '-cf', tarPath, '.',
    ]);
  } finally {
    if (originalDockerfile !== null)
      fs.writeFileSync(dockerfilePath, originalDockerfile);
  }

  log(`Sending build context to Podman for image ${imageName}...`);

  const encodedTag = encodeURIComponent(imageName);
  const buildArgsParam = encodeURIComponent(JSON.stringify(buildEnv));
  const apiPath =
    Object.keys(buildEnv).length > 0
      ? `/v5.0.0/libpod/build?t=${encodedTag}&dockerfile=Dockerfile&buildargs=${buildArgsParam}`
      : `/v5.0.0/libpod/build?t=${encodedTag}&dockerfile=Dockerfile`;

  return new Promise((resolve, reject) => {
    const tarBuffer = fs.readFileSync(tarPath);
    const options: RequestOptions = {
      socketPath: PODMAN_SOCK,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-tar',
        'Content-Length': tarBuffer.length,
      },
    };

    const req = httpRequest(options, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (c) => (errBody += c));
        res.on('end', () => {
          try { fs.unlinkSync(tarPath); } catch { }
          reject(new Error(`Build API returned ${res.statusCode}: ${errBody}`));
        });
        return;
      }

      let buffer = '';
      let buildFailed = false;
      let buildError = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as {
              stream?: string; error?: string;
            };
            if (parsed.stream) process.stdout.write(parsed.stream);
            if (parsed.error) { buildFailed = true; buildError = parsed.error; }
          } catch { }
        }
      });

      res.on('end', () => {
        try { fs.unlinkSync(tarPath); } catch { }
        if (buildFailed) reject(new Error(`Build failed: ${buildError}`));
        else resolve();
      });

      res.on('error', (err) => {
        try { fs.unlinkSync(tarPath); } catch { }
        reject(err);
      });
    });

    req.on('error', (err) => {
      try { fs.unlinkSync(tarPath); } catch { }
      reject(err);
    });

    req.write(tarBuffer);
    req.end();
  });
}
