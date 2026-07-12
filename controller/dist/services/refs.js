"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLocalRef = resolveLocalRef;
exports.getInternalUrl = getInternalUrl;
const config_js_1 = require("../config.js");
function resolveLocalRef(name) {
    // Check databases first
    const databases = (0, config_js_1.readDatabases)();
    const db = databases.find(d => d.name === name);
    if (db) {
        return {
            name: db.name,
            internalPort: db.port || (db.type === 'mysql' ? 3306 : 5432),
            hostPort: db.host_port,
            type: 'database'
        };
    }
    // Then check apps
    const apps = (0, config_js_1.readApps)();
    const app = apps.find(a => a.name === name);
    if (app) {
        return {
            name: app.name,
            internalPort: app.port,
            hostPort: app.domain ? undefined : (app.port + 1000),
            type: 'app'
        };
    }
    return null;
}
function getInternalUrl(name, protocol = 'http') {
    const ref = resolveLocalRef(name);
    if (!ref)
        return name;
    return `${protocol}://${ref.name}:${ref.internalPort}`;
}
