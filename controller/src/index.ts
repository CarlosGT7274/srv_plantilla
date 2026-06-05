import Fastify from 'fastify';
import { appRoutes } from './routes/apps.js';
import { databaseRoutes } from './routes/databases.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const fastify = Fastify({ logger: true });

// ─── Health ───────────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({ status: 'ok' }));

// ─── Routes ───────────────────────────────────────────────────────────────────
fastify.register(appRoutes);
fastify.register(databaseRoutes);

// ─── Start ────────────────────────────────────────────────────────────────────
fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});
