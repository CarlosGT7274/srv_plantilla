"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILDS_DIR = exports.PODMAN_SOCK = void 0;
exports.podmanRequest = podmanRequest;
exports.ensureUOption = ensureUOption;
exports.splitEnvVars = splitEnvVars;
exports.buildImageViaSock = buildImageViaSock;
const http_1 = require("http");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
exports.PODMAN_SOCK = process.env.CONTAINER_HOST?.replace('unix://', '') ||
    `/run/user/1000/podman/podman.sock`;
exports.BUILDS_DIR = process.env.BUILDS_DIR || './builds';
// ─── Core HTTP over Unix socket ──────────────────────────────────────────────
// Se mantiene: sigue siendo necesario para INSPECCIÓN (health probes,
// identidad de imagen, conteo de puertos usados). Ya no se usa para crear,
// arrancar o destruir contenedores — eso es responsabilidad exclusiva de
// systemd vía services/systemd.ts.
function podmanRequest(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = (0, http_1.request)({
            socketPath: exports.PODMAN_SOCK,
            path: urlPath,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
                }
                catch {
                    resolve({ status: res.statusCode ?? 0, data: raw });
                }
            });
        });
        req.on('error', reject);
        if (payload)
            req.write(payload);
        req.end();
    });
}
// ─── Mounts: coherencia de identidad sin conocer UIDs de antemano ───────────
// Se mantiene: usado al generar el contenido del Quadlet (deploy.ts /
// database.ts), no al arrancar contenedores directamente.
function withUOption(opts) {
    return opts.includes('U') ? opts : [...opts, 'U'];
}
/** Variante para specs de volumen en formato Quadlet ("host:container:opts"). */
function ensureUOption(volumeSpec) {
    const [src, dst, ...opts] = volumeSpec.split(':');
    return [src, dst, ...withUOption(opts)].join(':');
}
// ─── Image build ─────────────────────────────────────────────────────────────
const BUILD_TIME_PATTERNS = [
    /^NEXT_PUBLIC_/, /^VITE_/, /^REACT_APP_/,
    /^NUXT_PUBLIC_/, /^PUBLIC_/, /^GATSBY_/,
];
function splitEnvVars(env) {
    const buildEnv = {};
    const runtimeEnv = {};
    for (const [k, v] of Object.entries(env)) {
        if (BUILD_TIME_PATTERNS.some((p) => p.test(k)))
            buildEnv[k] = v;
        else
            runtimeEnv[k] = v;
    }
    return { buildEnv, runtimeEnv };
}
async function buildImageViaSock(app, imageName, buildPath, log) {
    const { buildEnv } = splitEnvVars(app.env ?? {});
    const dockerfilePath = path_1.default.join(buildPath, 'Dockerfile');
    const tarPath = path_1.default.join(exports.BUILDS_DIR, `${path_1.default.basename(buildPath)}.tar`);
    let originalDockerfile = null;
    try {
        if (Object.keys(buildEnv).length > 0 && fs_1.default.existsSync(dockerfilePath)) {
            originalDockerfile = fs_1.default.readFileSync(dockerfilePath, 'utf-8');
            const argBlock = Object.keys(buildEnv)
                .map((k) => `ARG ${k}\nENV ${k}=$${k}`)
                .join('\n');
            fs_1.default.writeFileSync(dockerfilePath, originalDockerfile.replace(/^(FROM\s+\S[^\n]*)$/m, `$1\n${argBlock}`));
        }
        log(`Tarballing build context at ${buildPath}...`);
        await execFileAsync('tar', [
            '-C', buildPath,
            '--exclude=.git', '--exclude=node_modules',
            '--exclude=.next', '--exclude=dist',
            '-cf', tarPath, '.',
        ]);
    }
    finally {
        if (originalDockerfile !== null)
            fs_1.default.writeFileSync(dockerfilePath, originalDockerfile);
    }
    log(`Sending build context to Podman for image ${imageName}...`);
    const encodedTag = encodeURIComponent(imageName);
    const buildArgsParam = encodeURIComponent(JSON.stringify(buildEnv));
    const apiPath = Object.keys(buildEnv).length > 0
        ? `/v5.0.0/libpod/build?t=${encodedTag}&dockerfile=Dockerfile&buildargs=${buildArgsParam}`
        : `/v5.0.0/libpod/build?t=${encodedTag}&dockerfile=Dockerfile`;
    return new Promise((resolve, reject) => {
        const tarBuffer = fs_1.default.readFileSync(tarPath);
        const options = {
            socketPath: exports.PODMAN_SOCK,
            path: apiPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-tar',
                'Content-Length': tarBuffer.length,
            },
        };
        const req = (0, http_1.request)(options, (res) => {
            if (res.statusCode !== 200) {
                let errBody = '';
                res.on('data', (c) => (errBody += c));
                res.on('end', () => {
                    try {
                        fs_1.default.unlinkSync(tarPath);
                    }
                    catch { }
                    reject(new Error(`Build API returned ${res.statusCode}: ${errBody}`));
                });
                return;
            }
            let buffer = '';
            let buildFailed = false;
            let buildError = '';
            res.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.stream)
                            process.stdout.write(parsed.stream);
                        if (parsed.error) {
                            buildFailed = true;
                            buildError = parsed.error;
                        }
                    }
                    catch { }
                }
            });
            res.on('end', () => {
                try {
                    fs_1.default.unlinkSync(tarPath);
                }
                catch { }
                if (buildFailed)
                    reject(new Error(`Build failed: ${buildError}`));
                else
                    resolve();
            });
            res.on('error', (err) => {
                try {
                    fs_1.default.unlinkSync(tarPath);
                }
                catch { }
                reject(err);
            });
        });
        req.on('error', (err) => {
            try {
                fs_1.default.unlinkSync(tarPath);
            }
            catch { }
            reject(err);
        });
        req.write(tarBuffer);
        req.end();
    });
}
