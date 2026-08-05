"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveIdentityFromOciLayout = resolveIdentityFromOciLayout;
exports.resolveIdentityFromLoadedImage = resolveIdentityFromLoadedImage;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const podman_js_1 = require("./podman.js");
function parseUser(user) {
    if (!user)
        return { uid: null, gid: null };
    const [uid, gid] = user.split(':');
    return { uid: uid || null, gid: gid ?? null };
}
function readOciConfigBlob(imageLayoutDir) {
    const indexPath = path_1.default.join(imageLayoutDir, 'index.json');
    if (!fs_1.default.existsSync(indexPath)) {
        throw new Error(`No se encontró ${indexPath}: el layout OCI no existe o está incompleto`);
    }
    const index = JSON.parse(fs_1.default.readFileSync(indexPath, 'utf-8'));
    const manifestDigest = index.manifests?.[0]?.digest;
    if (!manifestDigest) {
        throw new Error(`No se encontró el digest del manifest en ${indexPath}`);
    }
    const [mAlgo, mHash] = manifestDigest.split(':');
    const manifestPath = path_1.default.join(imageLayoutDir, 'blobs', mAlgo, mHash);
    if (!fs_1.default.existsSync(manifestPath)) {
        throw new Error(`No se encontró el blob del manifest en ${manifestPath}`);
    }
    const manifest = JSON.parse(fs_1.default.readFileSync(manifestPath, 'utf-8'));
    const configDigest = manifest.config?.digest;
    if (!configDigest) {
        throw new Error(`No se encontró el digest de configuración en ${manifestPath}`);
    }
    const [cAlgo, cHash] = configDigest.split(':');
    const configPath = path_1.default.join(imageLayoutDir, 'blobs', cAlgo, cHash);
    if (!fs_1.default.existsSync(configPath)) {
        throw new Error(`No se encontró el blob de configuración en ${configPath}`);
    }
    return JSON.parse(fs_1.default.readFileSync(configPath, 'utf-8'));
}
/**
 * Resuelve la identidad de una imagen a partir de su OCI layout en disco,
 * ANTES de que esa imagen exista como tal en el storage de Podman.
 * Se usa durante el build (CNB) para leer la identidad del run-image ya
 * sembrado en el layout, y así hacer coincidir el ownership de los
 * archivos exportados con el usuario que la imagen final va a usar.
 *
 * No hardcodea ninguna ruta de aplicación. Falla explícitamente (no cae
 * a un fallback silencioso) si el layout está incompleto o corrupto,
 * porque un fallback silencioso aquí es exactamente el tipo de bug que
 * generó el EACCES original: usar una identidad equivocada sin que nadie
 * se entere.
 */
function resolveIdentityFromOciLayout(imageLayoutDir) {
    const blob = readOciConfigBlob(imageLayoutDir);
    const user = blob.config?.User ?? '';
    const { uid, gid } = parseUser(user);
    return {
        user,
        uid,
        gid,
        workingDir: blob.config?.WorkingDir || null,
    };
}
/**
 * Resuelve la identidad de una imagen YA cargada en el storage de Podman,
 * consultando su Config.User/Config.WorkingDir vía la API remota.
 * Uso previsto: auditoría/logging del deploy. NO se usa para forzar un
 * `User=` en runtime — Podman ya aplica Config.User de la imagen por
 * defecto al crear el contenedor sin overrides.
 */
async function resolveIdentityFromLoadedImage(imageName) {
    const { status, data } = await (0, podman_js_1.podmanRequest)('GET', `/v5.0.0/libpod/images/${encodeURIComponent(imageName)}/json`);
    if (status !== 200) {
        throw new Error(`No se pudo inspeccionar la imagen "${imageName}" (status ${status})`);
    }
    const info = data;
    const user = info.Config?.User ?? '';
    const { uid, gid } = parseUser(user);
    return {
        user,
        uid,
        gid,
        workingDir: info.Config?.WorkingDir || null,
    };
}
