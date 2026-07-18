import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppConfig } from '../types.js';
import { resolveIdentityFromOciLayout } from './image-identity.js';

const execFileAsync = promisify(execFile);

const BUILDER_IMAGE =
  process.env.CNB_BUILDER_IMAGE || 'docker.io/paketobuildpacks/builder-jammy-base:latest';
const PLATFORM_API = process.env.CNB_PLATFORM_API || '0.12';

// IMPORTANTE: este path debe existir IDÉNTICO dentro y fuera del contenedor
// del controller (mismo mount que /home/deploy/databases). Los `podman run`
// de abajo corren en modo remoto (CONTAINER_HOST) y montan estas rutas
// contra el filesystem real del host, no el del contenedor del controller.
const CNB_WORK_DIR = process.env.CNB_WORK_DIR || '/home/deploy/cnb-builds';

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

async function ensureBuilderPulled(builderImage: string, log: (msg: string) => void): Promise<void> {
  try {
    await podmanExec(['image', 'exists', builderImage], log);
  } catch {
    log(`Descargando builder CNB ${builderImage}...`);
    await podmanExec(['pull', builderImage], log);
  }
}

// ─── Run image → OCI layout ──────────────────────────────────────────────
// Platform API 0.12 con -layout NO resuelve imágenes contra un registry:
// exige que <run-image> ya exista dentro de -layout-dir, en una ruta
// derivada de su referencia. Esta conversión es genérica para cualquier
// referencia tipo "registry/repo:tag" (formato que usa /cnb/run.toml en
// cualquier builder CNB conforme al spec, no solo Paketo).
function normalizeOciRef(ref: string): string {
  const slashIdx = ref.indexOf('/');
  if (slashIdx === -1) {
    return `index.docker.io/library/${ref}`;
  }

  const firstSegment = ref.slice(0, slashIdx);
  const hasDotOrPort = firstSegment.includes('.') || firstSegment.includes(':');

  if (hasDotOrPort) {
    let host = firstSegment;
    const rest = ref.slice(slashIdx + 1);
    if (host === 'docker.io') {
      host = 'index.docker.io';
    }
    return `${host}/${rest}`;
  } else {
    return `index.docker.io/${ref}`;
  }
}

function refToLayoutPath(ref: string): string {
  const normalized = normalizeOciRef(ref);
  let repoPart = normalized;
  let versionPart = 'latest';

  if (normalized.includes('@')) {
    const parts = normalized.split('@');
    repoPart = parts[0];
    versionPart = parts[1];
  } else {
    const lastColon = normalized.lastIndexOf(':');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastColon > lastSlash) {
      repoPart = normalized.slice(0, lastColon);
      versionPart = normalized.slice(lastColon + 1);
    }
  }

  return `${repoPart}/${versionPart}`;
}

async function getDefaultRunImageRef(
  builderImage: string,
  log: (msg: string) => void
): Promise<string> {
  const stdout = await podmanExec(
    ['run', '--rm', '--entrypoint', 'cat', builderImage, '/cnb/run.toml'],
    log
  );
  const match = stdout.match(/image\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`No se pudo leer la run image por default desde /cnb/run.toml de ${builderImage}`);
  }
  return match[1];
}

async function seedRunImageIntoLayout(
  runImageRef: string,
  ociOut: string,
  log: (msg: string) => void
): Promise<void> {
  const layoutRelPath = refToLayoutPath(runImageRef);
  const layoutAbsPath = path.join(ociOut, layoutRelPath);
  fs.mkdirSync(layoutAbsPath, { recursive: true });

  log(`Poblando layout dir con run image (${runImageRef} → ${layoutRelPath})...`);
  await execFileAsync('skopeo', [
    'copy',
    `docker://${runImageRef}`,
    `oci:${layoutAbsPath}:${runImageRef.includes(':') ? runImageRef.split(':').pop() : 'latest'}`,
  ]);
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
      `El creator no generó ${indexPath} — la exportación falló antes de escribir el layout`
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

function getOciImageConfigDigest(imageLayoutDir: string): string {
  const indexPath = path.join(imageLayoutDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `El creator no generó ${indexPath} — la exportación falló antes de escribir el layout`
    );
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
    manifests?: Array<{ digest: string }>;
  };
  const manifestDigest = index.manifests?.[0]?.digest;
  if (!manifestDigest) {
    throw new Error(`No se encontró el digest del manifest en ${indexPath}`);
  }

  const [algo, hash] = manifestDigest.split(':');
  const manifestPath = path.join(imageLayoutDir, 'blobs', algo, hash);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No se encontró el blob del manifest en ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    config?: { digest: string };
  };
  const configDigest = manifest.config?.digest;
  if (!configDigest) {
    throw new Error(`No se encontró el digest de configuración en ${manifestPath}`);
  }
  return configDigest;
}

export async function buildWithCNB(
  app: AppConfig,
  imageName: string,
  buildPath: string,
  log: (msg: string) => void
): Promise<void> {
  const builderImage = BUILDER_IMAGE;
  await ensureBuilderPulled(builderImage, log);

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

  // ─── Procfile automático ───────────────────────────────────────────────
  // Si el usuario configuró BP_LAUNCHPOINT en el env de la app, generamos
  // un Procfile explícito en el workspace. Esto es necesario porque algunos
  // repositorios traen un start.sh que usa herramientas de desarrollo
  // (como `nest start`) que no existen en la imagen de producción. El
  // Procfile tiene la prioridad más alta en los buildpacks de Paketo y
  // anula cualquier start.sh o script de package.json.
  if (app.env?.BP_LAUNCHPOINT) {
    const procfilePath = path.join(workspace, 'Procfile');
    fs.writeFileSync(procfilePath, `web: node ${app.env.BP_LAUNCHPOINT}\n`);
    log(`Procfile generado automáticamente: web: node ${app.env.BP_LAUNCHPOINT}`);
  }

  // ─── Poblar oci-out con la run image ANTES de correr creator ───────────
  // Sin esto, el analyzer/exporter en modo -layout buscan la run image en
  // una ruta local dentro de -layout-dir y no la encuentran. Leemos la
  // referencia default desde el propio /cnb/run.toml del builder en vez
  // de hardcodearla, para no depender de que el stack/run-image de este
  // builder no cambie nunca.
  const runImageRef = await getDefaultRunImageRef(builderImage, log);
  await seedRunImageIntoLayout(runImageRef, ociOut, log);

  // ─── Identidad de ejecución de la imagen final ─────────────────────────
  // La identidad del run-image se usa ÚNICAMENTE para indicarle al lifecycle
  // con qué uid/gid debe quedar el contenido exportado (vía -uid/-gid del
  // propio creator, mecanismo provisto por el spec CNB para exactamente
  // este caso: desacoplar el ownership del contenido exportado de la
  // identidad con la que corre el propio proceso del lifecycle).
  //
  // NO se usa para decidir con qué usuario corre el PROCESO del lifecycle
  // — eso rompe operaciones internas del lifecycle sobre /layers, que
  // dependen de la identidad que el BUILDER le da a su propio usuario de
  // build, no a la del run-image (son imágenes distintas, cada una con su
  // propio /etc/passwd y sus propios permisos internos independientes).
  const runImageLayoutDir = path.join(ociOut, refToLayoutPath(runImageRef));
  const runImageIdentity = resolveIdentityFromOciLayout(runImageLayoutDir);
  const uid = runImageIdentity.uid ?? '0';
  const gid = runImageIdentity.gid ?? runImageIdentity.uid ?? '0';

  log(
    `Identidad del run image (${runImageRef}): uid=${uid} gid=${gid}` +
    (runImageIdentity.workingDir ? `, workdir=${runImageIdentity.workingDir}` : '')
  );

  // ─── Creator ────────────────────────────────────────────────────────────
  // Sin -u: el proceso del lifecycle corre con la identidad default del
  // builder (la que ese builder le da permisos para operar sobre /layers,
  // /cnb, etc). El ownership de la app exportada se controla vía -uid/-gid,
  // que apuntan a la identidad del run-image — así el contenido horneado
  // en la imagen final coincide con Config.User de esa MISMA imagen, sin
  // que el proceso del lifecycle necesite correr como ese usuario.
  log('CNB · creator');
  await podmanExec(
    [
      'run', '--rm',
      '-e', `CNB_PLATFORM_API=${PLATFORM_API}`,
      '-e', 'CNB_EXPERIMENTAL_MODE=warn',
      '-v', `${workspace}:/workspace`,
      '-v', `${layers}:/layers`,
      '-v', `${platform}:/platform`,
      '-v', `${ociOut}:/oci-out`,
      '--entrypoint', '/cnb/lifecycle/creator',
      builderImage,
      '-app', '/workspace',
      '-platform', '/platform',
      '-layers', '/layers',
      '-uid', uid,
      '-gid', gid,
      '-layout', '-layout-dir', '/oci-out',
      imageName,
    ],
    log
  );

  const imageLayoutDir = path.join(ociOut, refToLayoutPath(imageName));
  const refName = readOciLayoutRefName(imageLayoutDir);
  const imageId = getOciImageConfigDigest(imageLayoutDir);

  log(`OCI layout listo (ref=${refName}, ID=${imageId}). Convirtiendo a oci-archive...`);

  const tarPath = path.join(base, 'image.tar');
  await execFileAsync('skopeo', [
    'copy',
    `oci:${imageLayoutDir}:${refName}`,
    `oci-archive:${tarPath}`,
  ]);

  log('Importando al storage real de Podman (podman load remoto)...');
  await podmanExec(['load', '--input', tarPath], log);

  fs.rmSync(tarPath, { force: true });

  log(`Etiquetando la imagen ${imageId} como ${imageName}...`);
  await podmanExec(['tag', imageId, imageName], log);
  log(`Imagen ${imageName} disponible en Podman.`);
}
