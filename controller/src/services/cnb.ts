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

// ─── Identidad del stack (CNB_USER_ID / CNB_GROUP_ID) ────────────────────
// Spec (RFC 0026, lifecycle-all.md):
//   -uid  (required) ← env CNB_USER_ID  → "UID of user in the stack's build
//                                          and run images"
//   -gid  (required) ← env CNB_GROUP_ID → "GID of user's group in the
//                                          stack's build and run images"
// Y de la guía "Create a build base image": "The USER in the image config
// must match the user indicated by CNB_USER_ID and CNB_GROUP_ID."
//
// Es decir: el spec espera UNA sola identidad compartida por el build image
// Y el run image del mismo stack. -uid/-gid NO es "la identidad que yo
// quiero que tenga el contenido exportado" tomada de donde sea — es
// específicamente la identidad que el BUILDER declara vía estas dos env
// vars. Si el run image reportara una identidad distinta, eso sería una
// inconsistencia del stack, no algo que el platform deba resolver leyendo
// el run image por su cuenta.
//
// Por eso la leemos del builder, no del OCI layout del run image (que es
// lo que hacía la versión anterior de este archivo, y por lo que EnsureOwner
// del lifecycle nunca encontraba coincidencia: exigíamos un uid que ni el
// propio builder usa).
interface StackIdentity {
  uid: string;
  gid: string;
}

async function getStackIdentity(
  builderImage: string,
  log: (msg: string) => void
): Promise<StackIdentity> {
  const stdout = await podmanExec(
    ['inspect', builderImage, '--format', '{{ range .Config.Env }}{{ println . }}{{ end }}'],
    log
  );
  const lines = stdout.split('\n');
  const find = (name: string): string | null => {
    const line = lines.find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : null;
  };

  const uid = find('CNB_USER_ID');
  const gid = find('CNB_GROUP_ID');

  if (!uid || !gid) {
    throw new Error(
      `El builder ${builderImage} no declara CNB_USER_ID/CNB_GROUP_ID en su ` +
      `Config.Env — no es un builder CNB conforme al spec, o la imagen está corrupta.`
    );
  }

  return { uid, gid };
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

  // ─── Identidad del stack: SIEMPRE la del builder, nunca la del run image ──
  // Ver comentario extenso arriba de getStackIdentity(). Esta es la única
  // fuente de verdad para -uid/-gid del lifecycle.
  const { uid, gid } = await getStackIdentity(builderImage, log);
  log(`Identidad del stack (builder CNB_USER_ID/CNB_GROUP_ID): uid=${uid} gid=${gid}`);

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
  if (app.env?.BP_LAUNCHPOINT) {
    const procfilePath = path.join(workspace, 'Procfile');
    fs.writeFileSync(procfilePath, `web: node ${app.env.BP_LAUNCHPOINT}\n`);
    log(`Procfile generado automáticamente: web: node ${app.env.BP_LAUNCHPOINT}`);
  }

  // ─── Poblar oci-out con la run image ANTES de correr creator ───────────
  const runImageRef = await getDefaultRunImageRef(builderImage, log);
  await seedRunImageIntoLayout(runImageRef, ociOut, log);

  // ─── Pre-chown de workspace/layers/platform/oci-out ─────────────────────
  // EnsureOwner (fase analyze, incluida en creator) compara el owner actual
  // de /layers (y afines) contra el -uid/-gid que le pasamos. Si no
  // coincide, intenta corregirlo con un chown interno — y ese chown SOLO
  // funciona si el proceso del lifecycle es root. Como más abajo corremos
  // creator con `-u <uid>:<gid>` (no root), ese chown interno fallaría con
  // "operation not permitted" si el ownership no está ya correcto de
  // antemano. Por eso lo dejamos correcto ANTES, con un contenedor efímero
  // que sí corre como root (sin -u), evitando depender del chown interno
  // del lifecycle por completo.
  log(`Ajustando ownership de workspace/layers/platform/oci-out a ${uid}:${gid}...`);
  await podmanExec(
    [
      'run', '--rm',
      '-v', `${workspace}:/w`,
      '-v', `${layers}:/l`,
      '-v', `${platform}:/p`,
      '-v', `${ociOut}:/o`,
      'docker.io/library/busybox:latest',
      'chown', '-R', `${uid}:${gid}`, '/w', '/l', '/p', '/o',
    ],
    log
  );

  // ─── Creator ────────────────────────────────────────────────────────────
  // Con -u <uid>:<gid>: el proceso del lifecycle corre exactamente con la
  // identidad que -uid/-gid le declara. Como el ownership de /workspace,
  // /layers, /platform y /oci-out ya quedó ajustado al mismo uid:gid en el
  // paso anterior, EnsureOwner encuentra todo en orden y nunca necesita
  // ejecutar un chown privilegiado — que es justo lo que fallaba antes.
  log('CNB · creator');
  await podmanExec(
    [
      'run', '--rm',
      '-u', `${uid}:${gid}`,
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
