"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDatabase = createDatabase;
exports.removeDatabase = removeDatabase;
exports.getDatabaseStatus = getDatabaseStatus;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const net_1 = __importDefault(require("net"));
const podman_js_1 = require("./podman.js");
const systemd_js_1 = require("./systemd.js");
const DATABASES_DIR = process.env.DATABASES_DIR || '/home/deploy/databases';
const SERVER_HOST = process.env.SERVER_HOST || 'localhost';
const HOST_PORT_RANGE_START = 3310;
const HOST_PORT_RANGE_END = 3400;
const DB_PROFILES = {
    mysql: {
        image: 'docker.io/library/mysql:8.0',
        defaultPort: 3306,
        dataDir: '/var/lib/mysql',
        resolveEnv: (input) => {
            const user = input.username ?? input.name;
            const pass = input.password ?? 'changeme';
            const dbName = input.database ?? input.name;
            const port = input.port ?? 3306;
            const env = {
                MYSQL_ROOT_PASSWORD: pass,
                MYSQL_DATABASE: dbName,
            };
            if (user !== 'root') {
                env.MYSQL_USER = user;
                env.MYSQL_PASSWORD = pass;
            }
            return {
                env,
                connectionString: `mysql://${user}:${pass}@${input.name}:${port}/${dbName}`,
            };
        },
    },
    postgres: {
        image: 'docker.io/library/postgres:16-alpine',
        defaultPort: 5432,
        dataDir: '/var/lib/postgresql/data',
        resolveEnv: (input) => {
            const user = input.username ?? input.name;
            const pass = input.password ?? 'changeme';
            const dbName = input.database ?? input.name;
            const port = input.port ?? 5432;
            return {
                env: {
                    POSTGRES_USER: user,
                    POSTGRES_PASSWORD: pass,
                    POSTGRES_DB: dbName,
                },
                connectionString: `postgresql://${user}:${pass}@${input.name}:${port}/${dbName}`,
            };
        },
    },
};
function isPortFree(port) {
    return new Promise((resolve) => {
        const server = net_1.default.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => server.close(() => resolve(true)));
        server.listen(port, '127.0.0.1');
    });
}
async function getPodmanUsedPorts() {
    const { status, data } = await (0, podman_js_1.podmanRequest)('GET', '/v5.0.0/libpod/containers/json?all=true');
    if (status !== 200)
        return [];
    const containers = data;
    const usedPorts = [];
    for (const c of containers) {
        if (c.Ports) {
            for (const p of c.Ports) {
                const port = p.host_port ?? p.hostPort;
                if (port)
                    usedPorts.push(port);
            }
        }
    }
    return usedPorts;
}
async function findFreeHostPort(jsonUsedPorts) {
    const podmanUsedPorts = await getPodmanUsedPorts();
    const allUsedPorts = Array.from(new Set([...jsonUsedPorts, ...podmanUsedPorts]));
    for (let p = HOST_PORT_RANGE_START; p <= HOST_PORT_RANGE_END; p++) {
        if (allUsedPorts.includes(p))
            continue;
        if (await isPortFree(p))
            return p;
    }
    throw new Error(`No free port found in range ${HOST_PORT_RANGE_START}-${HOST_PORT_RANGE_END}`);
}
// ─── Contenido del Quadlet ────────────────────────────────────────────────────
// Igual que en deploy.ts: solo construye el string. Escribirlo, recargar
// systemd y reiniciar la unidad es responsabilidad exclusiva de systemd.ts.
function buildDbQuadletContent(input, profile, env, hostPort) {
    const hostDataDir = path_1.default.join(DATABASES_DIR, input.name);
    const containerPort = input.port ?? profile.defaultPort;
    const managedLabel = process.env.MANAGED_LABEL || 'servidor-jair.managed';
    const envLines = Object.entries(env)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join('\n');
    const externalAccessLabels = input.external_access ? [
        `Label=traefik.enable=true`,
        `Label=traefik.tcp.routers.${input.name}.entrypoints=${input.type}`,
        `Label=traefik.tcp.routers.${input.name}.rule=HostSNI(\`*\`)`,
        `Label=traefik.tcp.services.${input.name}.loadbalancer.server.port=${containerPort}`,
    ] : [];
    return [
        `[Unit]`,
        `Description=Database ${input.name} (${input.type})`,
        `After=network-online.target`,
        ``,
        `[Container]`,
        `Image=${profile.image}`,
        `ContainerName=${input.name}`,
        `Network=proxy-net`,
        `Label=${managedLabel}=true`,
        `PublishPort=127.0.0.1:${hostPort}:${containerPort}`,
        `Volume=${hostDataDir}:${profile.dataDir}:z,U`,
        envLines,
        ``,
        ...externalAccessLabels,
        ``,
        `[Service]`,
        `Restart=always`,
        `RestartSec=5s`,
        ``,
        `[Install]`,
        `WantedBy=default.target`,
    ].join('\n').trim();
}
async function createDatabase(input, usedHostPorts, log) {
    const profile = DB_PROFILES[input.type];
    if (!profile)
        throw new Error(`Unsupported database type: ${input.type}`);
    const port = input.port ?? profile.defaultPort;
    const hostPort = input.host_port ?? await findFreeHostPort(usedHostPorts);
    const hostDataDir = path_1.default.join(DATABASES_DIR, input.name);
    const { env, connectionString } = profile.resolveEnv(input);
    fs_1.default.mkdirSync(hostDataDir, { recursive: true });
    const quadletContent = buildDbQuadletContent(input, profile, env, hostPort);
    await (0, systemd_js_1.applyQuadlet)(`${input.name}.container`, `${input.name}.service`, quadletContent, log);
    log(`Database ${input.name} is up on host port ${hostPort}.`);
    return {
        name: input.name,
        type: input.type,
        port,
        host_port: hostPort,
        connectionString,
        tunnel: `ssh -L ${hostPort}:127.0.0.1:${hostPort} deploy@${SERVER_HOST} -N`,
    };
}
async function removeDatabase(name, log) {
    await (0, systemd_js_1.teardownUnit)(`${name}.container`, `${name}.service`, log);
    log(`Done. Data at ${DATABASES_DIR}/${name} preserved.`);
}
async function getDatabaseStatus(name) {
    const { status, data } = await (0, podman_js_1.podmanRequest)('GET', `/v5.0.0/libpod/containers/${name}/json`);
    if (status !== 200)
        return { running: false };
    const info = data;
    return {
        running: info.State?.Status === 'running',
        status: info.State?.Status,
    };
}
