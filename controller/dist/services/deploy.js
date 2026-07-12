"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDeployInProgress = isDeployInProgress;
exports.triggerDeploy = triggerDeploy;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const http_1 = require("http");
const simple_git_1 = __importDefault(require("simple-git"));
const podman_js_1 = require("./podman.js");
const cnb_js_1 = require("./cnb.js");
const config_js_1 = require("../config.js");
const refs_js_1 = require("./refs.js");
const QUADLET_DIR = process.env.QUADLET_DIR || '/quadlets';
// ─── Lock por app ─────────────────────────────────────────────────────────
// Sin esto, dos POST /deploy/:name (o un webhook duplicado + un click
// manual) para la MISMA app corren en paralelo sobre el mismo
// CNB_WORK_DIR/<app> (workspace/layers/platform/oci-out) y BUILDS_DIR/<app>
// (git clone). El resetDir() de cnb.ts de la segunda llamada borra
// archivos que la primera está usando activamente a mitad del build —
// eso es lo que produce tanto "ENOTEMPTY" (la segunda, al hacer rm -rf)
// como el "lstat .../sbom.syft.json: no such file or directory" (la
// primera, cuando el creator llega a leer un archivo que la segunda ya
// borró). No es un bug de Paketo/lifecycle, es una carrera de archivos.
const inFlightDeploys = new Set();
function isDeployInProgress(name) {
    return inFlightDeploys.has(name);
}
// ─── Git ─────────────────────────────────────────────────────────────────────
function buildCloneUrl(app) {
    if (!app.private)
        return app.repo;
    const token = app.github_token || process.env.GITHUB_TOKEN || '';
    if (!token)
        throw new Error(`App "${app.name}" is private but no token is set`);
    return app.repo.replace('https://', `https://${token}@`);
}
async function cloneOrPull(app, buildPath) {
    const cloneUrl = buildCloneUrl(app);
    if (!fs_1.default.existsSync(buildPath)) {
        await (0, simple_git_1.default)().clone(cloneUrl, buildPath);
    }
    else {
        await (0, simple_git_1.default)(buildPath).remote(['set-url', 'origin', cloneUrl]);
        await (0, simple_git_1.default)(buildPath).pull();
    }
}
// ─── Estrategia de build: Containerfile/Dockerfile vs CNB ───────────────────
function findContainerfile(buildPath) {
    const dockerfile = path_1.default.join(buildPath, 'Dockerfile');
    const containerfile = path_1.default.join(buildPath, 'Containerfile');
    if (fs_1.default.existsSync(dockerfile))
        return dockerfile;
    if (fs_1.default.existsSync(containerfile))
        return containerfile;
    return null;
}
// ─── Health detection ─────────────────────────────────────────────────────────
function detectHealthCheckInCode(buildPath) {
    try {
        const patterns = [
            "@Get('health')",
            "router.get('/health'",
            "app.get('/health'",
            "\"/health\"",
            "'/health'",
        ];
        for (const pattern of patterns) {
            try {
                (0, child_process_1.execSync)(`grep -rli "${pattern}" ${buildPath}/src ${buildPath}/app 2>/dev/null`);
                return '/health';
            }
            catch { }
        }
    }
    catch { }
    return null;
}
// ─── Health probe ─────────────────────────────────────────────────────────────
async function probeHealthEndpoint(app, log, healthPath) {
    await new Promise((r) => setTimeout(r, 3000));
    const { status, data } = await podmanInspect(app.name);
    if (status !== 200)
        return;
    const info = data;
    const ip = info.NetworkSettings?.Networks?.['proxy-net']?.IPAddress;
    if (!ip)
        return;
    const hasHealth = await new Promise((resolve) => {
        const req = (0, http_1.request)({ host: ip, port: app.port, path: healthPath, method: 'GET' }, (res) => resolve(res.statusCode === 200));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
    if (hasHealth) {
        log(`✓  ${app.name}: ${healthPath} detected`);
    }
    else {
        log(`⚠  ${app.name}: no ${healthPath} endpoint found — add GET ${healthPath} returning 200 to enable Traefik health checks`);
    }
}
async function podmanInspect(name) {
    const { podmanRequest } = await import('./podman.js');
    return podmanRequest('GET', `/v5.0.0/libpod/containers/${name}/json`);
}
// ─── Quadlet ─────────────────────────────────────────────────────────────────
function writeAppQuadlet(app, imageName, healthPath) {
    const { runtimeEnv } = (0, podman_js_1.splitEnvVars)(app.env ?? {});
    const envLines = Object.entries(runtimeEnv)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join('\n');
    const volumeLines = (app.volumes ?? [])
        .map((v) => `Volume=${v}`)
        .join('\n');
    const healthLines = healthPath ? [
        `HealthCmd=curl -f http://localhost:${app.port}${healthPath} || exit 1`,
        `HealthInterval=10s`,
        `HealthRetries=3`,
        `HealthTimeout=5s`,
        `HealthStartPeriod=30s`,
    ] : [];
    const traefikLabels = app.domain ? [
        `Label=traefik.enable=true`,
        `Label=traefik.http.routers.${app.name}.rule=Host(\`${app.domain}\`)`,
        `Label=traefik.http.routers.${app.name}.entrypoints=websecure`,
        `Label=traefik.http.routers.${app.name}.tls.certresolver=letsencrypt`,
        `Label=traefik.http.services.${app.name}.loadbalancer.server.port=${app.port}`,
        ...(healthPath ? [`Label=traefik.http.services.${app.name}.loadbalancer.healthcheck.path=${healthPath}`] : []),
    ] : [
        `PublishPort=127.0.0.1:${app.port + 1000}:${app.port}`
    ];
    const managedLabel = process.env.MANAGED_LABEL || 'servidor-jair.managed';
    const content = [
        `[Unit]`,
        `Description=PaaS App ${app.name}`,
        `After=network-online.target`,
        ``,
        `[Container]`,
        `Image=${imageName}`,
        `ContainerName=${app.name}`,
        `Network=proxy-net`,
        `Label=${managedLabel}=true`,
        volumeLines,
        envLines,
        ``,
        ...healthLines,
        ``,
        ...traefikLabels,
        ``,
        `[Service]`,
        `Restart=always`,
        `RestartSec=5s`,
        ``,
        `[Install]`,
        `WantedBy=default.target`,
    ].join('\n').trim();
    fs_1.default.writeFileSync(path_1.default.join(QUADLET_DIR, `${app.name}.container`), content);
}
// ─── Main deploy ─────────────────────────────────────────────────────────────
async function triggerDeploy(app, log) {
    if (inFlightDeploys.has(app.name)) {
        throw new Error(`Deploy para "${app.name}" ya está en curso — se ignora esta llamada en vez de correr en paralelo sobre el mismo workspace`);
    }
    inFlightDeploys.add(app.name);
    const buildPath = path_1.default.join(podman_js_1.BUILDS_DIR, app.name);
    try {
        log(`Starting deploy for ${app.name}...`);
        // ✅ Inyectar credenciales de BDD automáticamente si se referencia una local
        const databases = (0, config_js_1.readDatabases)();
        const dbHost = app.env?.DATABASE_HOST || app.env?.DB_HOST;
        const dbRef = dbHost ? (0, refs_js_1.resolveLocalRef)(dbHost) : null;
        const dbConfig = databases.find(d => d.name === dbHost);
        if (dbConfig && dbRef) {
            log(`🔗  Linking database: ${dbConfig.name}`);
            app.env = {
                ...app.env,
                DATABASE_USER: dbConfig.username || dbConfig.name,
                DB_USER: dbConfig.username || dbConfig.name,
                DATABASE_PASSWORD: dbConfig.password || 'changeme',
                DB_PASSWORD: dbConfig.password || 'changeme',
                DATABASE_NAME: dbConfig.database || dbConfig.name,
                DB_NAME: dbConfig.database || dbConfig.name,
                DATABASE_PORT: String(dbRef.internalPort),
                DB_PORT: String(dbRef.internalPort),
            };
        }
        await cloneOrPull(app, buildPath);
        let healthPath = app.health_path || null;
        if (app.health_check !== false && !healthPath) {
            healthPath = detectHealthCheckInCode(buildPath);
            if (healthPath)
                log(`🔍 Auto-detected health check at: ${healthPath}`);
            else
                log(`⚠  No health check detected in source code. Routing will be immediate.`);
        }
        const commitHash = (0, child_process_1.execSync)('git rev-parse --short HEAD', {
            cwd: buildPath,
        }).toString().trim();
        const imageName = `localhost/${app.name}:${commitHash}`;
        const containerfilePath = findContainerfile(buildPath);
        if (containerfilePath) {
            log(`Containerfile/Dockerfile detectado (${path_1.default.basename(containerfilePath)}) → build vía Podman/Buildah`);
            await (0, podman_js_1.buildImageViaSock)(app, imageName, buildPath, log);
        }
        else {
            log(`Sin Containerfile/Dockerfile → build vía Cloud Native Buildpacks`);
            await (0, cnb_js_1.buildWithCNB)(app, imageName, buildPath, log);
        }
        writeAppQuadlet(app, imageName, healthPath);
        await (0, podman_js_1.stopAndRemoveContainer)(app.name);
        await (0, podman_js_1.startAppContainer)(app, imageName, healthPath);
        if (healthPath) {
            log(`Probing ${healthPath} endpoint on ${app.name}...`);
            probeHealthEndpoint(app, log, healthPath).catch(() => { });
        }
        log(`Deploy complete: ${app.name} @ ${imageName}`);
    }
    finally {
        inFlightDeploys.delete(app.name);
    }
}
