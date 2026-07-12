"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseRoutes = databaseRoutes;
const config_js_1 = require("../config.js");
const database_js_1 = require("../services/database.js");
const VALID_TYPES = ['mysql', 'postgres'];
async function databaseRoutes(fastify) {
    fastify.get('/databases', async () => {
        const databases = (0, config_js_1.readDatabases)();
        const results = await Promise.all(databases.map(async (db) => {
            const { running, status } = await (0, database_js_1.getDatabaseStatus)(db.name);
            return {
                name: db.name,
                type: db.type,
                port: db.port,
                host_port: db.host_port,
                running,
                status: status ?? 'unknown',
            };
        }));
        return results;
    });
    fastify.post('/databases', async (request, reply) => {
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
        const databases = (0, config_js_1.readDatabases)();
        if (databases.find((d) => d.name === body.name))
            return reply.status(409).send({ error: `Database "${body.name}" already exists` });
        const usedHostPorts = databases
            .map((d) => d.host_port)
            .filter((p) => p !== undefined);
        try {
            const logs = [];
            const result = await (0, database_js_1.createDatabase)(body, usedHostPorts, (msg) => {
                fastify.log.info(msg);
                logs.push(msg);
            });
            const metadata = {
                name: body.name,
                type: body.type,
                port: result.port,
                host_port: result.host_port,
                username: body.username,
                password: body.password,
                database: body.database,
                ...(body.external_access ? { external_access: body.external_access } : {}),
            };
            databases.push(metadata);
            (0, config_js_1.writeDatabases)(databases);
            return reply.status(201).send({ ...result, logs });
        }
        catch (err) {
            fastify.log.error(`Failed to create DB ${body.name}: ${err.message}`);
            return reply.status(500).send({ error: err.message });
        }
    });
    fastify.delete('/databases/:name', async (request, reply) => {
        const { name } = request.params;
        const databases = (0, config_js_1.readDatabases)();
        const db = databases.find((d) => d.name === name);
        if (!db)
            return reply.status(404).send({ error: `Database "${name}" not found` });
        try {
            const logs = [];
            await (0, database_js_1.removeDatabase)(name, (msg) => {
                fastify.log.info(msg);
                logs.push(msg);
            });
            (0, config_js_1.writeDatabases)(databases.filter((d) => d.name !== name));
            return reply.send({ message: `Database "${name}" removed`, logs });
        }
        catch (err) {
            return reply.status(500).send({ error: err.message });
        }
    });
}
