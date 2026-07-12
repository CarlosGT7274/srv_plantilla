"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILDS_DIR = exports.PODMAN_SOCK = void 0;
exports.podmanRequest = podmanRequest;
exports.containerExists = containerExists;
exports.stopAndRemoveContainer = stopAndRemoveContainer;
exports.startAppContainer = startAppContainer;
exports.startDatabaseContainer = startDatabaseContainer;
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
// ─── Container lifecycle ─────────────────────────────────────────────────────
async function containerExists(name) {
    const { status } = await podmanRequest('GET', `/v5.0.0/libpod/containers/${name}/json`);
    return status === 200;
}
async function stopAndRemoveContainer(name) {
    if (!(await containerExists(name)))
        return;
    await podmanRequest('POST', `/v5.0.0/libpod/containers/${name}/stop`);
    await podmanRequest('DELETE', `/v5.0.0/libpod/containers/${name}?force=true`);
}
async function startAppContainer(app, imageName, healthPath) {
    const { runtimeEnv } = splitEnvVars(app.env ?? {});
    const managedLabel = process.env.MANAGED_LABEL || 'servidor-jair.managed';
    const labels = {
        [managedLabel]: 'true',
    };
    if (app.domain) {
        labels['traefik.enable'] = 'true';
        labels[`traefik.http.routers.${app.name}.rule`] = `Host(\`${app.domain}\`)`;
        labels[`traefik.http.routers.${app.name}.entrypoints`] = 'websecure';
        labels[`traefik.http.routers.${app.name}.tls.certresolver`] = 'letsencrypt';
        labels[`traefik.http.services.${app.name}.loadbalancer.server.port`] = String(app.port);
        if (healthPath) {
            labels[`traefik.http.services.${app.name}.loadbalancer.healthcheck.path`] = healthPath;
        }
    }
    const portmappings = app.domain ? [] : [
        {
            host_ip: '127.0.0.1',
            host_port: app.port + 1000,
            container_port: app.port,
            protocol: 'tcp',
        }
    ];
    const body = {
        name: app.name,
        image: imageName,
        env: runtimeEnv,
        Networks: { 'proxy-net': { aliases: [app.name] } },
        Labels: labels,
        netns: { nsmode: 'bridge' },
        restart_policy: 'always',
        portmappings,
        mounts: (app.volumes ?? []).map((v) => {
            const [src, dst, ...opts] = v.split(':');
            return { type: 'bind', source: src, destination: dst, options: opts };
        }),
    };
    if (healthPath) {
        body.healthconfig = {
            test: ['CMD-SHELL', `curl -f http://localhost:${app.port}${healthPath} || exit 1`],
            interval: 10_000_000_000,
            timeout: 5_000_000_000,
            retries: 3,
            start_period: 30_000_000_000,
        };
    }
    const { status, data } = await podmanRequest('POST', '/v5.0.0/libpod/containers/create', body);
    if (status !== 201)
        throw new Error(`Failed to create container: ${JSON.stringify(data)}`);
    const { status: s, data: d } = await podmanRequest('POST', `/v5.0.0/libpod/containers/${app.name}/start`);
    if (s !== 204)
        throw new Error(`Failed to start container: ${JSON.stringify(d)}`);
}
async function startDatabaseContainer(name, image, env, dataDir, hostDataDir) {
    const body = {
        name,
        image,
        env,
        Networks: { 'proxy-net': { aliases: [name] } },
        netns: { nsmode: 'bridge' },
        restart_policy: 'always',
        mounts: [
            {
                type: 'bind',
                source: hostDataDir,
                destination: dataDir,
                options: ['z'],
            },
        ],
    };
    const { status, data } = await podmanRequest('POST', '/v5.0.0/libpod/containers/create', body);
    if (status !== 201)
        throw new Error(`Failed to create DB container: ${JSON.stringify(data)}`);
    const { status: s, data: d } = await podmanRequest('POST', `/v5.0.0/libpod/containers/${name}/start`);
    if (s !== 204)
        throw new Error(`Failed to start DB container: ${JSON.stringify(d)}`);
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
