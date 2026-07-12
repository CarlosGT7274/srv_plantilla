"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildWithCNB = buildWithCNB;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const BUILDER_IMAGE = process.env.CNB_BUILDER_IMAGE || 'docker.io/paketobuildpacks/builder-jammy-base:latest';
const PLATFORM_API = process.env.CNB_PLATFORM_API || '0.12';
// IMPORTANTE: este path debe existir IDÉNTICO dentro y fuera del contenedor
// del controller (mismo mount que /home/deploy/databases). Los `podman run`
// de abajo corren en modo remoto (CONTAINER_HOST) y montan estas rutas
// contra el filesystem real del host, no el del contenedor del controller.
const CNB_WORK_DIR = process.env.CNB_WORK_DIR || '/home/deploy/cnb-builds';
async function podmanExec(args, log) {
    log(`$ podman ${args.join(' ')}`);
    try {
        const { stdout, stderr } = await execFileAsync('podman', args, {
            maxBuffer: 1024 * 1024 * 50,
        });
        if (stderr.trim())
            log(stderr.trim());
        return stdout;
    }
    catch (err) {
        const e = err;
        if (e.stdout)
            log(e.stdout);
        if (e.stderr)
            log(e.stderr);
        throw new Error(`podman ${args[0]} failed: ${e.stderr || e.message}`);
    }
}
async function getBuilderIdentity(builderImage, log) {
    const stdout = await podmanExec(['inspect', builderImage, '--format', '{{ range .Config.Env }}{{ println . }}{{ end }}'], log);
    const lines = stdout.split('\n');
    const find = (name, fallback) => {
        const line = lines.find((l) => l.startsWith(`${name}=`));
        return line ? line.slice(name.length + 1).trim() : fallback;
    };
    return { uid: find('CNB_USER_ID', '1000'), gid: find('CNB_GROUP_ID', '1000') };
}
async function ensureBuilderPulled(builderImage, log) {
    try {
        await podmanExec(['image', 'exists', builderImage], log);
    }
    catch {
        log(`Descargando builder CNB ${builderImage}...`);
        await podmanExec(['pull', builderImage], log);
    }
}
// ─── Run image → OCI layout ──────────────────────────────────────────────
// Platform API 0.12 con -layout NO resuelve imágenes contra un registry:
// exige que <run-image> ya exista dentro de -layout-dir, en una ruta
// derivada de su referencia. Confirmado por el propio lifecycle en el log
// de ANALYZING de esta builder image:
//   Image with name "/oci-out/index.docker.io/paketobuildpacks/run-jammy-base/latest" not found
// i.e. "docker.io/paketobuildpacks/run-jammy-base:latest" -> "index.docker.io/paketobuildpacks/run-jammy-base/latest"
// Esta función replica esa misma conversión para cualquier referencia tipo
// "registry/repo:tag" (que es el único formato que usa /cnb/run.toml de
// los builders de Paketo). No cubre referencias por digest (@sha256) —
// no hace falta aquí porque run.toml siempre usa tags.
function normalizeOciRef(ref) {
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
    }
    else {
        return `index.docker.io/${ref}`;
    }
}
function refToLayoutPath(ref) {
    const normalized = normalizeOciRef(ref);
    let repoPart = normalized;
    let versionPart = 'latest';
    // Soporte para digest (@sha256:...) o tag (:tag)
    if (normalized.includes('@')) {
        const parts = normalized.split('@');
        repoPart = parts[0];
        versionPart = parts[1];
    }
    else {
        const lastColon = normalized.lastIndexOf(':');
        const lastSlash = normalized.lastIndexOf('/');
        if (lastColon > lastSlash) {
            repoPart = normalized.slice(0, lastColon);
            versionPart = normalized.slice(lastColon + 1);
        }
    }
    return `${repoPart}/${versionPart}`;
}
async function getDefaultRunImageRef(builderImage, log) {
    const stdout = await podmanExec(['run', '--rm', '--entrypoint', 'cat', builderImage, '/cnb/run.toml'], log);
    // run.toml: [[images]] \n image = "docker.io/paketobuildpacks/run-jammy-base:latest"
    const match = stdout.match(/image\s*=\s*"([^"]+)"/);
    if (!match) {
        throw new Error(`No se pudo leer la run image por default desde /cnb/run.toml de ${builderImage}`);
    }
    return match[1];
}
async function seedRunImageIntoLayout(runImageRef, ociOut, log) {
    const layoutRelPath = refToLayoutPath(runImageRef);
    const layoutAbsPath = path_1.default.join(ociOut, layoutRelPath);
    fs_1.default.mkdirSync(layoutAbsPath, { recursive: true });
    log(`Poblando layout dir con run image (${runImageRef} → ${layoutRelPath})...`);
    await execFileAsync('skopeo', [
        'copy',
        `docker://${runImageRef}`,
        `oci:${layoutAbsPath}:${runImageRef.includes(':') ? runImageRef.split(':').pop() : 'latest'}`,
    ]);
}
function resetDir(dir) {
    fs_1.default.rmSync(dir, { recursive: true, force: true });
    fs_1.default.mkdirSync(dir, { recursive: true });
}
function copyRecursive(src, dest) {
    fs_1.default.mkdirSync(dest, { recursive: true });
    for (const entry of fs_1.default.readdirSync(src, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules')
            continue;
        const s = path_1.default.join(src, entry.name);
        const d = path_1.default.join(dest, entry.name);
        if (entry.isDirectory())
            copyRecursive(s, d);
        else
            fs_1.default.copyFileSync(s, d);
    }
}
function writePlatformEnv(platformEnvDir, env) {
    fs_1.default.mkdirSync(platformEnvDir, { recursive: true });
    for (const f of fs_1.default.readdirSync(platformEnvDir))
        fs_1.default.unlinkSync(path_1.default.join(platformEnvDir, f));
    for (const [key, value] of Object.entries(env)) {
        fs_1.default.writeFileSync(path_1.default.join(platformEnvDir, key), value);
    }
}
function readOciLayoutRefName(ociOut) {
    const indexPath = path_1.default.join(ociOut, 'index.json');
    if (!fs_1.default.existsSync(indexPath)) {
        throw new Error(`El creator no generó ${indexPath} — la exportación falló antes de escribir el layout`);
    }
    const index = JSON.parse(fs_1.default.readFileSync(indexPath, 'utf-8'));
    const refName = index.manifests?.[0]?.annotations?.['org.opencontainers.image.ref.name'];
    if (!refName) {
        throw new Error(`No se encontró 'org.opencontainers.image.ref.name' en ${indexPath}`);
    }
    return refName;
}
function getOciImageConfigDigest(imageLayoutDir) {
    const indexPath = path_1.default.join(imageLayoutDir, 'index.json');
    if (!fs_1.default.existsSync(indexPath)) {
        throw new Error(`El creator no generó ${indexPath} — la exportación falló antes de escribir el layout`);
    }
    const index = JSON.parse(fs_1.default.readFileSync(indexPath, 'utf-8'));
    const manifestDigest = index.manifests?.[0]?.digest;
    if (!manifestDigest) {
        throw new Error(`No se encontró el digest del manifest en ${indexPath}`);
    }
    const [algo, hash] = manifestDigest.split(':');
    const manifestPath = path_1.default.join(imageLayoutDir, 'blobs', algo, hash);
    if (!fs_1.default.existsSync(manifestPath)) {
        throw new Error(`No se encontró el blob del manifest en ${manifestPath}`);
    }
    const manifest = JSON.parse(fs_1.default.readFileSync(manifestPath, 'utf-8'));
    const configDigest = manifest.config?.digest;
    if (!configDigest) {
        throw new Error(`No se encontró el digest de configuración en ${manifestPath}`);
    }
    return configDigest;
}
async function buildWithCNB(app, imageName, buildPath, log) {
    const builderImage = BUILDER_IMAGE;
    await ensureBuilderPulled(builderImage, log);
    const identity = await getBuilderIdentity(builderImage, log);
    const base = path_1.default.join(CNB_WORK_DIR, app.name);
    const workspace = path_1.default.join(base, 'workspace');
    const layers = path_1.default.join(base, 'layers');
    const platform = path_1.default.join(base, 'platform');
    const platformEnv = path_1.default.join(platform, 'env');
    const ociOut = path_1.default.join(base, 'oci-out');
    log('Preparando workspace CNB...');
    resetDir(base);
    fs_1.default.mkdirSync(workspace, { recursive: true });
    fs_1.default.mkdirSync(layers, { recursive: true });
    fs_1.default.mkdirSync(platform, { recursive: true });
    fs_1.default.mkdirSync(ociOut, { recursive: true });
    copyRecursive(buildPath, workspace);
    if (app.env)
        writePlatformEnv(platformEnv, app.env);
    // ─── Poblar oci-out con la run image ANTES de correr creator ───────────
    // Sin esto, el analyzer/exporter en modo -layout buscan la run image en
    // una ruta local dentro de -layout-dir y no la encuentran (ver comentario
    // en refToLayoutPath). Leemos la referencia default desde el propio
    // /cnb/run.toml del builder en vez de hardcodearla, para no depender de
    // que el stack/run-image de este builder no cambie nunca.
    const runImageRef = await getDefaultRunImageRef(builderImage, log);
    await seedRunImageIntoLayout(runImageRef, ociOut, log);
    // El lifecycle corre como el usuario 'cnb' del builder (uid/gid propios de
    // la imagen). Ajustamos permisos con un contenedor efímero en vez de
    // `podman unshare` porque unshare es una operación local y no cruza el
    // socket remoto (CONTAINER_HOST). Incluye oci-out (ya con la run image
    // adentro) para que el usuario del lifecycle pueda leerla.
    log(`Ajustando permisos para uid:gid ${identity.uid}:${identity.gid}...`);
    await podmanExec([
        'run', '--rm',
        '-v', `${workspace}:/w`, '-v', `${layers}:/l`,
        '-v', `${platform}:/p`, '-v', `${ociOut}:/o`,
        'docker.io/library/busybox:latest',
        'chown', '-R', `${identity.uid}:${identity.gid}`, '/w', '/l', '/p', '/o',
    ], log);
    const user = `${identity.uid}:${identity.gid}`;
    // ─── Creator ────────────────────────────────────────────────────────────
    // Sin -run-image: dejamos que resuelva por default vía /cnb/run.toml del
    // builder, que es exactamente la referencia que ya sembramos en oci-out
    // arriba. Pasar -run-image explícito con un tag de registry rompe en
    // modo -layout (el parser espera formato local "[path]@[digest]", no un
    // tag de registry — de ahí el error "identifier  does not have the
    // format" de la ronda anterior).
    log('CNB · creator');
    await podmanExec([
        'run', '--rm', '-u', user,
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
        '-layout', '-layout-dir', '/oci-out',
        imageName,
    ], log);
    const imageLayoutDir = path_1.default.join(ociOut, refToLayoutPath(imageName));
    const refName = readOciLayoutRefName(imageLayoutDir);
    const imageId = getOciImageConfigDigest(imageLayoutDir);
    log(`OCI layout listo (ref=${refName}, ID=${imageId}). Convirtiendo a oci-archive...`);
    const tarPath = path_1.default.join(base, 'image.tar');
    await execFileAsync('skopeo', [
        'copy',
        `oci:${imageLayoutDir}:${refName}`,
        `oci-archive:${tarPath}`,
    ]);
    log('Importando al storage real de Podman (podman load remoto)...');
    await podmanExec(['load', '--input', tarPath], log);
    fs_1.default.rmSync(tarPath, { force: true });
    log(`Etiquetando la imagen ${imageId} como ${imageName}...`);
    await podmanExec(['tag', imageId, imageName], log);
    log(`Imagen ${imageName} disponible en Podman.`);
}
