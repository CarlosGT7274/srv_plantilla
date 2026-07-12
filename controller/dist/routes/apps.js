"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appRoutes = appRoutes;
const crypto_1 = __importDefault(require("crypto"));
const zod_1 = require("zod");
const config_js_1 = require("../config.js");
const deploy_js_1 = require("../services/deploy.js");
const GITHUB_SECRET = process.env.GITHUB_SECRET || '';
function verifySignature(payload, signature) {
    const hmac = crypto_1.default.createHmac('sha256', GITHUB_SECRET);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    }
    catch {
        return false;
    }
}
// ─── Validation Schemas ───────────────────────────────────────────────────────
const nameSchema = zod_1.z
    .string()
    .regex(/^[a-z0-9-]+$/, 'name must be lowercase alphanumeric with dashes only');
const envSchema = zod_1.z.record(zod_1.z.string(), zod_1.z.string()).optional();
// Body completo para crear una app nueva (POST) o reemplazarla entera (PUT)
const appConfigSchema = zod_1.z.object({
    name: nameSchema,
    repo: zod_1.z.string().url('repo must be a valid URL'),
    domain: zod_1.z.string().optional(),
    port: zod_1.z.number().int().positive(),
    private: zod_1.z.boolean().optional(),
    github_token: zod_1.z.string().optional(),
    env: envSchema,
    volumes: zod_1.z.array(zod_1.z.string()).optional(),
    health_check: zod_1.z.boolean().optional(),
    health_path: zod_1.z.string().optional(),
});
// Body parcial para PATCH: cualquier campo excepto "name" (ese va en la URL)
const appConfigPatchSchema = appConfigSchema.omit({ name: true }).partial();
function toPublicApp(app) {
    const { github_token, ...rest } = app;
    return rest;
}
async function appRoutes(fastify) {
    // ─── Listar apps ────────────────────────────────────────────────────────────
    fastify.get('/apps', async () => {
        const config = (0, config_js_1.readApps)();
        return config.map(toPublicApp);
    });
    // ─── Ver una app específica ─────────────────────────────────────────────────
    fastify.get('/apps/:name', async (request, reply) => {
        const config = (0, config_js_1.readApps)();
        const app = config.find((a) => a.name === request.params.name);
        if (!app)
            return reply.status(404).send({ error: `App "${request.params.name}" not found` });
        return toPublicApp(app);
    });
    // ─── Crear una app nueva (reemplaza el "vim apps.json") ────────────────────
    fastify.post('/apps', async (request, reply) => {
        const parsed = appConfigSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.flatten() });
        }
        const input = parsed.data;
        const config = (0, config_js_1.readApps)();
        if (config.find((a) => a.name === input.name)) {
            return reply.status(409).send({ error: `App "${input.name}" already exists` });
        }
        const newApp = { ...input };
        config.push(newApp);
        (0, config_js_1.writeApps)(config);
        return reply.status(201).send(toPublicApp(newApp));
    });
    // ─── Reemplazar una app completa (PUT) ──────────────────────────────────────
    fastify.put('/apps/:name', async (request, reply) => {
        const { name } = request.params;
        const parsed = appConfigSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.flatten() });
        }
        const input = parsed.data;
        if (input.name !== name) {
            return reply.status(400).send({ error: 'Body "name" must match URL param' });
        }
        const config = (0, config_js_1.readApps)();
        const index = config.findIndex((a) => a.name === name);
        if (index === -1) {
            return reply.status(404).send({ error: `App "${name}" not found` });
        }
        const updatedApp = { ...input };
        config[index] = updatedApp;
        (0, config_js_1.writeApps)(config);
        return reply.send(toPublicApp(updatedApp));
    });
    // ─── Actualizar parcialmente una app (PATCH) ────────────────────────────────
    fastify.patch('/apps/:name', async (request, reply) => {
        const { name } = request.params;
        const parsed = appConfigPatchSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.flatten() });
        }
        const patch = parsed.data;
        const config = (0, config_js_1.readApps)();
        const index = config.findIndex((a) => a.name === name);
        if (index === -1) {
            return reply.status(404).send({ error: `App "${name}" not found` });
        }
        const mergedEnv = patch.env
            ? { ...(config[index].env ?? {}), ...patch.env }
            : config[index].env;
        const updatedApp = {
            ...config[index],
            ...patch,
            env: mergedEnv,
        };
        config[index] = updatedApp;
        (0, config_js_1.writeApps)(config);
        return reply.send(toPublicApp(updatedApp));
    });
    // ─── Eliminar una app del config ────────────────────────────────────────────
    fastify.delete('/apps/:name', async (request, reply) => {
        const { name } = request.params;
        const config = (0, config_js_1.readApps)();
        const app = config.find((a) => a.name === name);
        if (!app)
            return reply.status(404).send({ error: `App "${name}" not found` });
        (0, config_js_1.writeApps)(config.filter((a) => a.name !== name));
        return reply.send({ message: `App "${name}" removed from config` });
    });
    // ─── Deploy manual por nombre ────────────────────────────────────────────────
    fastify.post('/deploy/:name', async (request, reply) => {
        const { name } = request.params;
        const config = (0, config_js_1.readApps)();
        const app = config.find((a) => a.name === name);
        if (!app)
            return reply.status(404).send({ error: `App "${name}" not found` });
        // Evita que dos deploys de la MISMA app corran en paralelo sobre el
        // mismo workspace (git clone / CNB_WORK_DIR) — ver services/deploy.ts.
        if ((0, deploy_js_1.isDeployInProgress)(name))
            return reply.status(409).send({
                error: `Deploy for "${name}" is already in progress`,
            });
        reply.send({ message: 'Deploy started', app: app.name });
        (0, deploy_js_1.triggerDeploy)(app, (msg) => fastify.log.info(msg)).catch((err) => fastify.log.error(`Deploy failed for ${name}: ${err.message}`));
    });
    // ─── Webhook de GitHub ───────────────────────────────────────────────────────
    fastify.post('/webhook', async (request, reply) => {
        const signature = request.headers['x-hub-signature-256'];
        if (!signature || !verifySignature(JSON.stringify(request.body), signature))
            return reply.status(401).send({ error: 'Invalid signature' });
        const payload = request.body;
        const config = (0, config_js_1.readApps)();
        const app = config.find((a) => a.repo === payload.repository.clone_url);
        if (!app)
            return reply.send({ message: 'Repo not managed' });
        // Mismo guard que el deploy manual: un webhook duplicado (GitHub
        // reintenta si no responde rápido, o un push + un deploy manual casi
        // simultáneo) no debe pisar un build que ya está corriendo.
        if ((0, deploy_js_1.isDeployInProgress)(app.name))
            return reply.status(409).send({
                error: `Deploy for "${app.name}" is already in progress`,
            });
        reply.send({ message: 'Deploy started', app: app.name });
        (0, deploy_js_1.triggerDeploy)(app, (msg) => fastify.log.info(msg)).catch((err) => fastify.log.error(`Deploy failed for ${app.name}: ${err.message}`));
    });
}
