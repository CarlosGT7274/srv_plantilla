"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const apps_js_1 = require("./routes/apps.js");
const databases_js_1 = require("./routes/databases.js");
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const fastify = (0, fastify_1.default)({ logger: true });
// ─── Health ───────────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({ status: 'ok' }));
// ─── Routes ───────────────────────────────────────────────────────────────────
fastify.register(apps_js_1.appRoutes);
fastify.register(databases_js_1.databaseRoutes);
// ─── Start ────────────────────────────────────────────────────────────────────
fastify.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
    fastify.log.error(err);
    process.exit(1);
});
