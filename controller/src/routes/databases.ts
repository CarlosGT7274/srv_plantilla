import { FastifyInstance } from 'fastify';
import { readDatabases, writeDatabases } from '../config.js';
import { DatabaseConfig, DatabaseType } from '../types.js';
import { DatabaseInput, createDatabase, removeDatabase, getDatabaseStatus } from '../services/database.js';

const VALID_TYPES: DatabaseType[] = ['mysql', 'postgres'];

export async function databaseRoutes(fastify: FastifyInstance): Promise<void> {
  // Lista todas las DBs con su status en tiempo real
  fastify.get('/databases', async () => {
    const databases = readDatabases();
    const results = await Promise.all(
      databases.map(async (db) => {
        const { running, status } = await getDatabaseStatus(db.name);
        return {
          name: db.name,
          type: db.type,
          port: db.port,
          running,
          status: status ?? 'unknown',
        };
      })
    );
    return results;
  });

  // Crear nueva DB
  fastify.post<{ Body: DatabaseInput }>('/databases', async (request, reply) => {
    const body = request.body;

    if (!body.name || !body.type)
      return reply.status(400).send({ error: 'name and type are required' });

    if (!VALID_TYPES.includes(body.type))
      return reply.status(400).send({
        error: `Invalid type. Valid: ${VALID_TYPES.join(', ')}`,
      });

    if (!/^[a-z0-9-]+$/.test(body.name))
      return reply.status(400).send({
        error: 'name must be lowercase alphanumeric with dashes only',
      });

    const databases = readDatabases();
    if (databases.find((d) => d.name === body.name))
      return reply.status(409).send({ error: `Database "${body.name}" already exists` });

    try {
      const logs: string[] = [];
      const result = await createDatabase(body, (msg) => {
        fastify.log.info(msg);
        logs.push(msg);
      });

      // Solo metadatos en databases.json — sin credenciales
      const metadata: DatabaseConfig = {
        name: body.name,
        type: body.type,
        ...(body.port ? { port: body.port } : {}),
        ...(body.external_access ? { external_access: body.external_access } : {}),
      };
      databases.push(metadata);
      writeDatabases(databases);

      return reply.status(201).send({ ...result, logs });
    } catch (err) {
      fastify.log.error(`Failed to create DB ${body.name}: ${(err as Error).message}`);
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Eliminar DB — preserva datos en disco
  fastify.delete<{ Params: { name: string } }>(
    '/databases/:name',
    async (request, reply) => {
      const { name } = request.params;
      const databases = readDatabases();
      const db = databases.find((d) => d.name === name);

      if (!db)
        return reply.status(404).send({ error: `Database "${name}" not found` });

      try {
        const logs: string[] = [];
        await removeDatabase(name, (msg) => {
          fastify.log.info(msg);
          logs.push(msg);
        });

        writeDatabases(databases.filter((d) => d.name !== name));
        return reply.send({ message: `Database "${name}" removed`, logs });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );
}
