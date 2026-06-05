import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { readApps } from '../config.js';
import { triggerDeploy } from '../services/deploy.js';

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

export async function appRoutes(fastify: FastifyInstance): Promise<void> {
  // Lista todas las apps configuradas
  fastify.get('/apps', async () => {
    const config = readApps();
    return config.map((a) => ({
      name: a.name,
      domain: a.domain,
      port: a.port,
      private: a.private ?? false,
      repo: a.repo,
    }));
  });

  // Deploy manual por nombre
  fastify.post<{ Params: { name: string } }>(
    '/deploy/:name',
    async (request, reply) => {
      const { name } = request.params;
      const config = readApps();
      const app = config.find((a) => a.name === name);
      if (!app)
        return reply.status(404).send({ error: `App "${name}" not found` });

      reply.send({ message: 'Deploy started', app: app.name });
      triggerDeploy(app, (msg) => fastify.log.info(msg)).catch((err) =>
        fastify.log.error(`Deploy failed for ${name}: ${err.message}`)
      );
    }
  );

  // Webhook de GitHub
  fastify.post('/webhook', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string;
    if (!signature || !verifySignature(JSON.stringify(request.body), signature))
      return reply.status(401).send({ error: 'Invalid signature' });

    const payload = request.body as { repository: { clone_url: string } };
    const config = readApps();
    const app = config.find((a) => a.repo === payload.repository.clone_url);
    if (!app) return reply.send({ message: 'Repo not managed' });

    reply.send({ message: 'Deploy started', app: app.name });
    triggerDeploy(app, (msg) => fastify.log.info(msg)).catch((err) =>
      fastify.log.error(`Deploy failed for ${app.name}: ${err.message}`)
    );
  });
}
