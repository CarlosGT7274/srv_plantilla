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
async function ensureBuilderPulled(builderImage, log) {
    try {
        await podmanExec(['image', 'exists', builderImage], log);
    }
    catch {
        log(`Descargando builder CNB ${builderImage}...`);
        await podmanExec(['pull', builderImage], log);
    }
}
async function getStackIdentity(builderImage, log) {
    const stdout = await podmanExec(['inspect', builderImage, '--format', '{{ range .Config.Env }}{{ println . }}{{ end }}'], log);
    const lines = stdout.split('\n');
    const find = (name) => {
        const line = lines.find((l) => l.startsWith(`${name}=`));
        return line ? line.slice(name.length + 1).trim() : null;
    };
    const uid = find('CNB_USER_ID');
    const gid = find('CNB_GROUP_ID');
    if (!uid || !gid) {
        throw new Error(`El builder ${builderImage} no declara CNB_USER_ID/CNB_GROUP_ID en su ` +
            `Config.Env — no es un builder CNB conforme al spec, o la imagen está corrupta.`);
    }
    return { uid, gid };
}
// ─── Run image → OCI layout ──────────────────────────────────────────────
// Platform API 0.12 con -layout NO resuelve imágenes contra un registry:
// exige que <run-image> ya exista dentro de -layout-dir, en una ruta
// derivada de su referencia. Esta conversión es genérica para cualquier
// referencia tipo "registry/repo:tag" (formato que usa /cnb/run.toml en
// cualquier builder CNB conforme al spec, no solo Paketo).
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
    // ─── Identidad del stack: SIEMPRE la del builder, nunca la del run image ──
    // Ver comentario extenso arriba de getStackIdentity(). Esta es la única
    // fuente de verdad para -uid/-gid del lifecycle.
    const { uid, gid } = await getStackIdentity(builderImage, log);
    log(`Identidad del stack (builder CNB_USER_ID/CNB_GROUP_ID): uid=${uid} gid=${gid}`);
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
    // ─── Procfile automático ───────────────────────────────────────────────
    if (app.env?.BP_LAUNCHPOINT) {
        const procfilePath = path_1.default.join(workspace, 'Procfile');
        fs_1.default.writeFileSync(procfilePath, `web: node ${app.env.BP_LAUNCHPOINT}\n`);
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
    await podmanExec([
        'run', '--rm',
        '-v', `${workspace}:/w`,
        '-v', `${layers}:/l`,
        '-v', `${platform}:/p`,
        '-v', `${ociOut}:/o`,
        'docker.io/library/busybox:latest',
        'chown', '-R', `${uid}:${gid}`, '/w', '/l', '/p', '/o',
    ], log);
    // ─── Leer project.toml y generar order.toml si existe ─────────────────
    const projectTomlPath = path_1.default.join(workspace, 'project.toml');
    let orderTomlArgs = [];
    if (fs_1.default.existsSync(projectTomlPath)) {
        log('project.toml detectado. Obteniendo versiones del builder...');
        const defaultOrder = await podmanExec(['run', '--rm', '--entrypoint', 'cat', builderImage, '/cnb/order.toml'], log);
        const versionMap = {};
        let currentId = '';
        for (const line of defaultOrder.split('\n')) {
            const idMatch = line.match(/id\s*=\s*"([^"]+)"/);
            if (idMatch)
                currentId = idMatch[1];
            const versionMatch = line.match(/version\s*=\s*"([^"]+)"/);
            if (versionMatch && currentId) {
                versionMap[currentId] = versionMatch[1];
                currentId = '';
            }
        }
        log('Extrayendo grupos de buildpacks del project.toml...');
        const projectToml = fs_1.default.readFileSync(projectTomlPath, 'utf-8');
        const groupMatches = [...projectToml.matchAll(/id\s*=\s*"([^"]+)"/g)];
        if (groupMatches.length > 0) {
            const orderTomlLines = ['[[order]]'];
            for (const match of groupMatches) {
                const id = match[1];
                orderTomlLines.push(`  [[order.group]]\n    id = "${id}"`);
                if (versionMap[id]) {
                    orderTomlLines.push(`    version = "${versionMap[id]}"`);
                }
            }
            const orderTomlContent = orderTomlLines.join('\n') + '\n';
            const orderTomlPath = path_1.default.join(platform, 'order.toml');
            fs_1.default.writeFileSync(orderTomlPath, orderTomlContent);
            log(`Generado order.toml en platform/order.toml:\n${orderTomlContent}`);
            orderTomlArgs = ['-v', `${orderTomlPath}:/cnb/order.toml:ro`];
        }
    }
    // ─── Creator ────────────────────────────────────────────────────────────
    // Con -u <uid>:<gid>: el proceso del lifecycle corre exactamente con la
    // identidad que -uid/-gid le declara. Como el ownership de /workspace,
    // /layers, /platform y /oci-out ya quedó ajustado al mismo uid:gid en el
    // paso anterior, EnsureOwner encuentra todo en orden y nunca necesita
    // ejecutar un chown privilegiado — que es justo lo que fallaba antes.
    log('CNB · creator');
    await podmanExec([
        'run', '--rm',
        '-u', `${uid}:${gid}`,
        '-e', `CNB_PLATFORM_API=${PLATFORM_API}`,
        '-e', 'CNB_EXPERIMENTAL_MODE=warn',
        '-v', `${workspace}:/workspace`,
        '-v', `${layers}:/layers`,
        '-v', `${platform}:/platform`,
        '-v', `${ociOut}:/oci-out`,
        ...orderTomlArgs,
        '--entrypoint', '/cnb/lifecycle/creator',
        builderImage,
        '-app', '/workspace',
        '-platform', '/platform',
        '-layers', '/layers',
        '-uid', uid,
        '-gid', gid,
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
