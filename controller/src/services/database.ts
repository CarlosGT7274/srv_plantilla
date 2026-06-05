import fs from 'fs';
import path from 'path';
import { request as httpRequest } from 'http';
import { DatabaseConfig, DatabaseType } from '../types.js';
import { PODMAN_SOCK, podmanRequest, stopAndRemoveContainer } from './podman.js';

const QUADLET_DIR = process.env.QUADLET_DIR || '/quadlets';
const DATABASES_DIR = process.env.DATABASES_DIR || '/home/deploy/databases';

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface DatabaseInput {
  name: string;
  type: DatabaseType;
  port?: number;
  password?: string;
  database?: string;
  username?: string;
  external_access?: boolean;
}

interface SecretMount {
  secretName: string;
  target: string; // env var dentro del contenedor
}

interface DbProfile {
  image: string;
  defaultPort: number;
  dataDir: string;
  resolveSecrets: (input: DatabaseInput) => {
    secrets: Record<string, string>;
    secretMounts: SecretMount[];
    nonSecretEnv: Record<string, string>;
    connectionString: string;
  };
}

// ─── Perfiles ─────────────────────────────────────────────────────────────────

const DB_PROFILES: Record<DatabaseType, DbProfile> = {
  mysql: {
    image: 'docker.io/library/mysql:8.0',
    defaultPort: 3306,
    dataDir: '/var/lib/mysql',
    resolveSecrets: (input) => {
      const user = input.username ?? input.name;
      const pass = input.password ?? 'changeme';
      const dbName = input.database ?? input.name;
      const port = input.port ?? 3306;
      return {
        secrets: {
          [`${input.name}-root-pass`]: pass,
          [`${input.name}-pass`]: pass,
        },
        secretMounts: [
          { secretName: `${input.name}-root-pass`, target: 'MYSQL_ROOT_PASSWORD' },
          { secretName: `${input.name}-pass`, target: 'MYSQL_PASSWORD' },
        ],
        nonSecretEnv: {
          MYSQL_USER: user,
          MYSQL_DATABASE: dbName,
        },
        connectionString: `mysql://${user}:${pass}@${input.name}:${port}/${dbName}`,
      };
    },
  },
  postgres: {
    image: 'docker.io/library/postgres:16-alpine',
    defaultPort: 5432,
    dataDir: '/var/lib/postgresql/data',
    resolveSecrets: (input) => {
      const user = input.username ?? input.name;
      const pass = input.password ?? 'changeme';
      const dbName = input.database ?? input.name;
      const port = input.port ?? 5432;
      return {
        secrets: {
          [`${input.name}-pass`]: pass,
        },
        secretMounts: [
          { secretName: `${input.name}-pass`, target: 'POSTGRES_PASSWORD' },
        ],
        nonSecretEnv: {
          POSTGRES_USER: user,
          POSTGRES_DB: dbName,
        },
        connectionString: `postgresql://${user}:${pass}@${input.name}:${port}/${dbName}`,
      };
    },
  },
};

// ─── Podman secrets (raw — acepta Buffer) ─────────────────────────────────────

function podmanSecretCreate(name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(value);
    const req = httpRequest(
      {
        socketPath: PODMAN_SOCK,
        path: `/v5.0.0/libpod/secrets/create?name=${encodeURIComponent(name)}`,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': payload.length,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          // 200/201 = ok, 409 = ya existe (no es error fatal)
          if (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 409)
            resolve();
          else
            reject(new Error(`Secret create failed ${res.statusCode}: ${body}`));
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Quadlet (sin credenciales en texto plano) ────────────────────────────────

function writeDbQuadlet(
  input: DatabaseInput,
  profile: DbProfile,
  secretMounts: SecretMount[],
  nonSecretEnv: Record<string, string>
): void {
  const hostDataDir = path.join(DATABASES_DIR, input.name);

  const envLines = Object.entries(nonSecretEnv)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n');

  // Credenciales referenciadas por nombre de secret, nunca por valor
  const secretLines = secretMounts
    .map(({ secretName, target }) => `Secret=${secretName},type=env,target=${target}`)
    .join('\n');

  const content = [
    `[Unit]`,
    `Description=Database ${input.name} (${input.type})`,
    `After=network-online.target`,
    ``,
    `[Container]`,
    `Image=${profile.image}`,
    `ContainerName=${input.name}`,
    `Network=proxy-net`,
    `Volume=${hostDataDir}:${profile.dataDir}:z`,
    envLines,
    secretLines,
    ``,
    `[Service]`,
    `Restart=always`,
    `RestartSec=5s`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
  ].join('\n').trim();

  fs.writeFileSync(path.join(QUADLET_DIR, `${input.name}.container`), content);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CreateDatabaseResult {
  name: string;
  type: DatabaseType;
  port: number;
  connectionString: string;
}

export async function createDatabase(
  input: DatabaseInput,
  log: (msg: string) => void
): Promise<CreateDatabaseResult> {
  const profile = DB_PROFILES[input.type];
  if (!profile) throw new Error(`Unsupported database type: ${input.type}`);

  const port = input.port ?? profile.defaultPort;
  const hostDataDir = path.join(DATABASES_DIR, input.name);
  const { secrets, secretMounts, nonSecretEnv, connectionString } =
    profile.resolveSecrets(input);

  // 1. Directorio de datos
  log(`Creating data directory at ${hostDataDir}...`);
  fs.mkdirSync(hostDataDir, { recursive: true });

  // 2. Podman secrets — credenciales nunca tocan el disco en texto plano
  log(`Creating Podman secrets for ${input.name}...`);
  for (const [secretName, secretValue] of Object.entries(secrets)) {
    await podmanSecretCreate(secretName, secretValue);
    log(`  Secret "${secretName}" stored.`);
  }

  // 3. Quadlet sin credenciales
  log(`Writing Quadlet for ${input.name}...`);
  writeDbQuadlet(input, profile, secretMounts, nonSecretEnv);

  // 4. Crear contenedor referenciando los secrets
  log(`Starting container ${input.name}...`);
  const body = {
    name: input.name,
    image: profile.image,
    env: nonSecretEnv,
    secrets: secretMounts.map(({ secretName, target }) => ({
      source: secretName,
      target,
    })),
    Networks: { 'proxy-net': { aliases: [input.name] } },
    netns: { nsmode: 'bridge' },
    restart_policy: 'always',
    mounts: [{
      type: 'bind',
      source: hostDataDir,
      destination: profile.dataDir,
      options: ['z'],
    }],
  };

  const { status, data } = await podmanRequest(
    'POST', '/v5.0.0/libpod/containers/create', body
  );
  if (status !== 201)
    throw new Error(`Failed to create container: ${JSON.stringify(data)}`);

  const { status: s, data: d } = await podmanRequest(
    'POST', `/v5.0.0/libpod/containers/${input.name}/start`
  );
  if (s !== 204)
    throw new Error(`Failed to start container: ${JSON.stringify(d)}`);

  log(`Database ${input.name} is up.`);
  return { name: input.name, type: input.type, port, connectionString };
}

export async function removeDatabase(
  name: string,
  log: (msg: string) => void
): Promise<void> {
  log(`Stopping container ${name}...`);
  await stopAndRemoveContainer(name);

  // Limpiar secrets de Podman
  log(`Removing Podman secrets...`);
  for (const suffix of ['pass', 'root-pass']) {
    const secretName = `${name}-${suffix}`;
    const { status } = await podmanRequest(
      'DELETE', `/v5.0.0/libpod/secrets/${secretName}`
    );
    if (status === 204) log(`  Secret "${secretName}" removed.`);
  }

  // Limpiar Quadlet
  const quadletPath = path.join(QUADLET_DIR, `${name}.container`);
  if (fs.existsSync(quadletPath)) {
    fs.unlinkSync(quadletPath);
    log(`Quadlet removed.`);
  }

  log(`Done. Data at ${DATABASES_DIR}/${name} preserved.`);
}

export async function getDatabaseStatus(name: string): Promise<{
  running: boolean;
  status?: string;
}> {
  const { status, data } = await podmanRequest(
    'GET', `/v5.0.0/libpod/containers/${name}/json`
  );
  if (status !== 200) return { running: false };
  const info = data as { State?: { Status?: string } };
  return {
    running: info.State?.Status === 'running',
    status: info.State?.Status,
  };
}
