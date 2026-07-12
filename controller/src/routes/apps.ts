import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { readApps, writeApps } from '../config.js';
import { triggerDeploy, isDeployInProgress } from '../services/deploy.js';
import { AppConfig } from '../types.js';

const GITHUB_SECRET = process.env.GITHUB_SECRET || '';

function verifySignature(payload: string, signature: string): boolean {
  const hmac = crypto.createHmac('sha256', GITHUB_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
}

// ─── Validation Schemas ───────────────────────────────────────────────────────

const nameSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'name must be lowercase alphanumeric with dashes only');

const envSchema = z.record(z.string(), z.string()).optional();

// Body completo para crear una app nueva (POST) o reemplazarla entera (PUT)
const appConfigSchema = z.object({
  name: nameSchema,
  repo: z.string().url('repo must be a valid URL'),
  domain: z.string().optional(),
  port: z.number().int().positive(),
  private: z.boolean().optional(),
  github_token: z.string().optional(),
  env: envSchema,
  volumes: z.array(z.string()).optional(),
  health_check: z.boolean().optional(),
  health_path: z.string().optional(),
});

// Body parcial para PATCH: cualquier campo excepto "name" (ese va en la URL)
const appConfigPatchSchema = appConfigSchema.omit({ name: true }).partial();

type AppConfigInput = z.infer<typeof appConfigSchema>;
type AppConfigPatchInput = z.infer<typeof appConfigPatchSchema>;

function toPublicApp(app: AppConfig): Omit<AppConfig, 'github_token'> {
  const { github_token, ...rest } = app;
  return rest;
}

export async function appRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── Listar apps ────────────────────────────────────────────────────────────
  fastify.get('/apps', async () => {
    const config = readApps();
    return config.map(toPublicApp);
  });

  // ─── Ver una app específica ─────────────────────────────────────────────────
  fastify.get<{ Params: { name: string } }>('/apps/:name', async (request, reply) => {
    const config = readApps();
    const app = config.find((a) => a.name === request.params.name);
    if (!app) return reply.status(404).send({ error: `App "${request.params.name}" not found` });
    return toPublicApp(app);
  });

  // ─── Crear una app nueva (reemplaza el "vim apps.json") ────────────────────
  fastify.post<{ Body: unknown }>('/apps', async (request, reply) => {
    const parsed = appConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const input: AppConfigInput = parsed.data;

    const config = readApps();
    if (config.find((a) => a.name === input.name)) {
      return reply.status(409).send({ error: `App "${input.name}" already exists` });
    }

    const newApp: AppConfig = { ...input };
    config.push(newApp);
    writeApps(config);

    return reply.status(201).send(toPublicApp(newApp));
  });

  // ─── Reemplazar una app completa (PUT) ──────────────────────────────────────
  fastify.put<{ Params: { name: string }; Body: unknown }>(
    '/apps/:name',
    async (request, reply) => {
      const { name } = request.params;
      const parsed = appConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const input: AppConfigInput = parsed.data;

      if (input.name !== name) {
        return reply.status(400).send({ error: 'Body "name" must match URL param' });
      }

      const config = readApps();
      const index = config.findIndex((a) => a.name === name);
      if (index === -1) {
        return reply.status(404).send({ error: `App "${name}" not found` });
      }

      const updatedApp: AppConfig = { ...input };
      config[index] = updatedApp;
      writeApps(config);

      return reply.send(toPublicApp(updatedApp));
    }
  );

  // ─── Actualizar parcialmente una app (PATCH) ────────────────────────────────
  fastify.patch<{ Params: { name: string }; Body: unknown }>(
    '/apps/:name',
    async (request, reply) => {
      const { name } = request.params;
      const parsed = appConfigPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const patch: AppConfigPatchInput = parsed.data;

      const config = readApps();
      const index = config.findIndex((a) => a.name === name);
      if (index === -1) {
        return reply.status(404).send({ error: `App "${name}" not found` });
      }

      const mergedEnv = patch.env
        ? { ...(config[index].env ?? {}), ...patch.env }
        : config[index].env;

      const updatedApp: AppConfig = {
        ...config[index],
        ...patch,
        env: mergedEnv,
      };
      config[index] = updatedApp;
      writeApps(config);

      return reply.send(toPublicApp(updatedApp));
    }
  );

  // ─── Eliminar una app del config ────────────────────────────────────────────
  fastify.delete<{ Params: { name: string } }>('/apps/:name', async (request, reply) => {
    const { name } = request.params;
    const config = readApps();
    const app = config.find((a) => a.name === name);
    if (!app) return reply.status(404).send({ error: `App "${name}" not found` });

    writeApps(config.filter((a) => a.name !== name));
    return reply.send({ message: `App "${name}" removed from config` });
  });

  // ─── Deploy manual por nombre ────────────────────────────────────────────────
  fastify.post<{ Params: { name: string } }>(
    '/deploy/:name',
    async (request, reply) => {
      const { name } = request.params;
      const config = readApps();
      const app = config.find((a) => a.name === name);
      if (!app)
        return reply.status(404).send({ error: `App "${name}" not found` });

      // Evita que dos deploys de la MISMA app corran en paralelo sobre el
      // mismo workspace (git clone / CNB_WORK_DIR) — ver services/deploy.ts.
      if (isDeployInProgress(name))
        return reply.status(409).send({
          error: `Deploy for "${name}" is already in progress`,
        });

      reply.send({ message: 'Deploy started', app: app.name });
      triggerDeploy(app, (msg) => fastify.log.info(msg)).catch((err: Error) =>
        fastify.log.error(`Deploy failed for ${name}: ${err.message}`)
      );
    }
  );

  // ─── Webhook de GitHub ───────────────────────────────────────────────────────
  fastify.post('/webhook', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    if (!signature || !verifySignature(JSON.stringify(request.body), signature))
      return reply.status(401).send({ error: 'Invalid signature' });

    const payload = request.body as { repository: { clone_url: string } };
    const config = readApps();
    const app = config.find((a) => a.repo === payload.repository.clone_url);
    if (!app) return reply.send({ message: 'Repo not managed' });

    // Mismo guard que el deploy manual: un webhook duplicado (GitHub
    // reintenta si no responde rápido, o un push + un deploy manual casi
    // simultáneo) no debe pisar un build que ya está corriendo.
    if (isDeployInProgress(app.name))
      return reply.status(409).send({
        error: `Deploy for "${app.name}" is already in progress`,
      });

    reply.send({ message: 'Deploy started', app: app.name });
    triggerDeploy(app, (msg) => fastify.log.info(msg)).catch((err: Error) =>
      fastify.log.error(`Deploy failed for ${app.name}: ${err.message}`)
    );
  });
}
