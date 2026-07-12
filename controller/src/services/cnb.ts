import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppConfig } from '../types.js';

const execFileAsync = promisify(execFile);

const BUILDER_IMAGE =
  process.env.CNB_BUILDER_IMAGE || 'docker.io/paketobuildpacks/builder-jammy-base:latest';
const PLATFORM_API = process.env.CNB_PLATFORM_API || '0.12';

// IMPORTANTE: este path debe existir IDÉNTICO dentro y fuera del contenedor
// del controller (mismo mount que /home/deploy/databases). Los `podman run`
// de abajo corren en modo remoto (CONTAINER_HOST) y montan estas rutas
// contra el filesystem real del host, no el del contenedor del controller.
const CNB_WORK_DIR = process.env.CNB_WORK_DIR || '/home/deploy/cnb-builds';

interface BuilderIdentity {
  uid: string;
  gid: string;
}

async function podmanExec(args: string[], log: (msg: string) => void): Promise<string> {
  log(`$ podman ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync('podman', args, {
      maxBuffer: 1024 * 1024 * 50,
    });
    if (stderr.trim()) log(stderr.trim());
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    if (e.stdout) log(e.stdout);
    if (e.stderr) log(e.stderr);
    throw new Error(`podman ${args[0]} failed: ${e.stderr || e.message}`);
  }
}

async function getBuilderIdentity(
  builderImage: string,
  log: (msg: string) => void
): Promise<BuilderIdentity> {
  const stdout = await podmanExec(
    ['inspect', builderImage, '--format', '{{ range .Config.Env }}{{ println . }}{{ end }}'],
    log
  );
  const lines = stdout.split('\n');
  const find = (name: string, fallback: string) => {
    const line = lines.find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : fallback;
  };
  return { uid: find('CNB_USER_ID', '1000'), gid: find('CNB_GROUP_ID', '1000') };
}

async function ensureBuilderPulled(builderImage: string, log: (msg: string) => void): Promise<void> {
  try {
    await podmanExec(['image', 'exists', builderImage], log);
  } catch {
    log(`Descargando builder CNB ${builderImage}...`);
    await podmanExec(['pull', builderImage], log);
  }
}

function resetDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function writePlatformEnv(platformEnvDir: string, env: Record<string, string>): void {
  fs.mkdirSync(platformEnvDir, { recursive: true });
  for (const f of fs.readdirSync(platformEnvDir)) fs.unlinkSync(path.join(platformEnvDir, f));
  for (const [key, value] of Object.entries(env)) {
    fs.writeFileSync(path.join(platformEnvDir, key), value);
  }
}

function readOciLayoutRefName(ociOut: string): string {
  const indexPath = path.join(ociOut, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `El exporter no generó ${indexPath} — la fase exporter falló antes de escribir el layout`
    );
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
    manifests?: Array<{ annotations?: Record<string, string> }>;
  };
  const refName = index.manifests?.[0]?.annotations?.['org.opencontainers.image.ref.name'];
  if (!refName) {
    throw new Error(`No se encontró 'org.opencontainers.image.ref.name' en ${indexPath}`);
  }
  return refName;
}

export async function buildWithCNB(
  app: AppConfig,
  imageName: string,
  buildPath: string,
  log: (msg: string) => void
): Promise<void> {
  const builderImage = BUILDER_IMAGE;
  await ensureBuilderPulled(builderImage, log);
  const identity = await getBuilderIdentity(builderImage, log);

  const base = path.join(CNB_WORK_DIR, app.name);
  const workspace = path.join(base, 'workspace');
  const layers = path.join(base, 'layers');
  const platform = path.join(base, 'platform');
  const platformEnv = path.join(platform, 'env');
  const ociOut = path.join(base, 'oci-out');

  log('Preparando workspace CNB...');
  resetDir(base);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(layers, { recursive: true });
  fs.mkdirSync(platform, { recursive: true });
  fs.mkdirSync(ociOut, { recursive: true });
  copyRecursive(buildPath, workspace);
  if (app.env) writePlatformEnv(platformEnv, app.env);

  // El lifecycle corre como el usuario 'cnb' del builder (uid/gid propios de
  // la imagen). Ajustamos permisos con un contenedor efímero en vez de
  // `podman unshare` porque unshare es una operación local y no cruza el
  // socket remoto (CONTAINER_HOST).
  log(`Ajustando permisos para uid:gid ${identity.uid}:${identity.gid}...`);
  await podmanExec(
    [
      'run', '--rm',
      '-v', `${workspace}:/w`, '-v', `${layers}:/l`,
      '-v', `${platform}:/p`, '-v', `${ociOut}:/o`,
      'docker.io/library/busybox:latest',
      'chown', '-R', `${identity.uid}:${identity.gid}`, '/w', '/l', '/p', '/o',
    ],
    log
  );

  const user = `${identity.uid}:${identity.gid}`;
  const runPhase = (entrypoint: string, extraArgs: string[]) =>
    podmanExec(
      [
        'run', '--rm', '-u', user,
        '-e', `CNB_PLATFORM_API=${PLATFORM_API}`,
        '-v', `${workspace}:/workspace`,
        '-v', `${layers}:/layers`,
        '-v', `${platform}:/platform`,
        '-v', `${ociOut}:/oci-out`,
        '--entrypoint', entrypoint,
        builderImage,
        ...extraArgs,
      ],
      log
    );

  log('CNB · detector');
  await runPhase('/cnb/lifecycle/detector', [
    '-app', '/workspace', '-layers', '/layers', '-platform', '/platform',
  ]);

  log('CNB · analyzer');
  await runPhase('/cnb/lifecycle/analyzer', [
    '-layout', '-layout-dir', '/oci-out',
    '-app', '/workspace', '-layers', '/layers',
    imageName,
  ]);

  log('CNB · builder');
  await runPhase('/cnb/lifecycle/builder', [
    '-app', '/workspace', '-layers', '/layers', '-platform', '/platform',
    '-group', '/layers/group.toml', '-plan', '/layers/plan.toml',
  ]);

  log('CNB · exporter');
  await runPhase('/cnb/lifecycle/exporter', [
    '-app', '/workspace', '-layers', '/layers', '-group', '/layers/group.toml',
    '-layout', '-layout-dir', '/oci-out',
    imageName,
  ]);

  const refName = readOciLayoutRefName(ociOut);
  log(`OCI layout listo (ref=${refName}). Convirtiendo a docker-archive...`);

  const tarPath = path.join(base, 'image.tar');
  await execFileAsync('skopeo', [
    'copy',
    `oci:${ociOut}:${refName}`,
    `docker-archive:${tarPath}:${imageName}`,
  ]);

  log('Importando al storage real de Podman (podman load remoto)...');
  await podmanExec(['load', '--input', tarPath], log);

  fs.rmSync(tarPath, { force: true });
  log(`Imagen ${imageName} disponible en Podman.`);
}
