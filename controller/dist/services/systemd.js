"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeQuadletIfChanged = writeQuadletIfChanged;
exports.removeQuadletFile = removeQuadletFile;
exports.daemonReloadUser = daemonReloadUser;
exports.restartUnit = restartUnit;
exports.stopUnit = stopUnit;
exports.disableUnit = disableUnit;
exports.getUnitStatus = getUnitStatus;
exports.waitForActive = waitForActive;
exports.applyQuadlet = applyQuadlet;
exports.teardownUnit = teardownUnit;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const QUADLET_DIR = process.env.QUADLET_DIR || '/quadlets';
async function systemctl(args) {
    try {
        const { stdout } = await execFileAsync('systemctl', ['--user', ...args], {
            maxBuffer: 1024 * 1024 * 10,
        });
        return stdout;
    }
    catch (err) {
        const e = err;
        throw new Error(`systemctl ${args.join(' ')} failed: ${e.stderr || e.message}`);
    }
}
function hashContent(content) {
    return crypto_1.default.createHash('sha256').update(content).digest('hex');
}
/**
 * Escribe el archivo .container solo si el contenido cambió. Devuelve true
 * si hubo escritura (y por lo tanto se requiere daemon-reload real), false
 * si el archivo ya estaba idéntico.
 */
function writeQuadletIfChanged(unitFileName, content) {
    const filePath = path_1.default.join(QUADLET_DIR, unitFileName);
    const normalized = content.trim() + '\n';
    if (fs_1.default.existsSync(filePath)) {
        const existing = fs_1.default.readFileSync(filePath, 'utf-8');
        if (hashContent(existing) === hashContent(normalized)) {
            return false;
        }
    }
    fs_1.default.writeFileSync(filePath, normalized);
    return true;
}
function removeQuadletFile(unitFileName) {
    const filePath = path_1.default.join(QUADLET_DIR, unitFileName);
    if (fs_1.default.existsSync(filePath))
        fs_1.default.unlinkSync(filePath);
}
async function daemonReloadUser() {
    await systemctl(['daemon-reload']);
}
async function restartUnit(unitName) {
    await systemctl(['restart', unitName]);
}
async function stopUnit(unitName) {
    try {
        await systemctl(['stop', unitName]);
    }
    catch {
        // Si la unidad no existía o ya estaba detenida, no es un error fatal.
    }
}
async function disableUnit(unitName) {
    try {
        await systemctl(['disable', unitName]);
    }
    catch {
        // Nada que deshabilitar — está bien.
    }
}
async function getUnitStatus(unitName) {
    const stdout = await systemctl([
        'show',
        unitName,
        '--property=ActiveState,SubState',
    ]);
    const props = {};
    for (const line of stdout.trim().split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1)
            continue;
        props[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return {
        activeState: props.ActiveState || 'unknown',
        subState: props.SubState || 'unknown',
    };
}
async function waitForActive(unitName, timeoutMs = 30_000, intervalMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = await getUnitStatus(unitName);
        if (status.activeState === 'active' && status.subState === 'running')
            return;
        if (status.activeState === 'failed') {
            throw new Error(`Unit ${unitName} entró en estado failed durante el arranque`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timeout esperando a que ${unitName} quede active/running`);
}
/**
 * Único punto de entrada para aplicar un cambio de ciclo de vida:
 * escribe (o actualiza) el Quadlet, recarga systemd, reinicia la unidad,
 * y espera a que quede corriendo. Esta función es la ÚNICA forma en la
 * que el controller debe crear/actualizar/arrancar una app o base de datos
 * gestionada por Quadlet. Nada más debe hablar con Podman para arrancar
 * contenedores.
 */
async function applyQuadlet(unitFileName, unitName, content, log) {
    const changed = writeQuadletIfChanged(unitFileName, content);
    log(changed ? `Quadlet ${unitFileName} actualizado.` : `Quadlet ${unitFileName} sin cambios.`);
    // Siempre recargamos: aunque el contenido no haya cambiado, puede haber
    // drift (por ejemplo, alguien tocó el archivo a mano, o hubo un restart
    // de systemd sin este proceso). Reload es idempotente y barato.
    await daemonReloadUser();
    log(`Reiniciando ${unitName}...`);
    await restartUnit(unitName);
    log(`Esperando a que ${unitName} quede activo...`);
    await waitForActive(unitName);
    log(`${unitName} está activo.`);
}
/**
 * Único punto de entrada para eliminar por completo una app o base de
 * datos del ciclo de vida gestionado por systemd: detiene la unidad,
 * la deshabilita, borra el Quadlet y recarga.
 */
async function teardownUnit(unitFileName, unitName, log) {
    await stopUnit(unitName);
    await disableUnit(unitName);
    removeQuadletFile(unitFileName);
    await daemonReloadUser();
    log(`${unitName} detenido y Quadlet eliminado.`);
}
