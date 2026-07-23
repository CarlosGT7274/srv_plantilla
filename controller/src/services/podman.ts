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
// Se mantiene: sigue siendo necesario para INSPECCIÓN (health probes,
// identidad de imagen, conteo de puertos usados). Ya no se usa para crear,
// arrancar o destruir contenedores — eso es responsabilidad exclusiva de
// systemd vía services/systemd.ts.

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

// ─── Mounts: coherencia de identidad sin conocer UIDs de antemano ───────────
// Se mantiene: usado al generar el contenido del Quadlet (deploy.ts /
// database.ts), no al arrancar contenedores directamente.

function withUOption(opts: string[]): string[] {
  return opts.includes('U') ? opts : [...opts, 'U'];
}

/** Variante para specs de volumen en formato Quadlet ("host:container:opts"). */
export function ensureUOption(volumeSpec: string): string {
  const [src, dst, ...opts] = volumeSpec.split(':');
  return [src, dst, ...withUOption(opts)].join(':');
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
