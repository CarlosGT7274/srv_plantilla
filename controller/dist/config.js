"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB_CONFIG_PATH = exports.CONFIG_PATH = void 0;
exports.readApps = readApps;
exports.writeApps = writeApps;
exports.readDatabases = readDatabases;
exports.writeDatabases = writeDatabases;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const CONFIG_PATH = process.env.CONFIG_PATH || './config/apps.json';
exports.CONFIG_PATH = CONFIG_PATH;
const DB_CONFIG_PATH = process.env.DB_CONFIG_PATH ||
    path_1.default.join(path_1.default.dirname(CONFIG_PATH), 'databases.json');
exports.DB_CONFIG_PATH = DB_CONFIG_PATH;
function readApps() {
    if (!fs_1.default.existsSync(CONFIG_PATH))
        return [];
    return JSON.parse(fs_1.default.readFileSync(CONFIG_PATH, 'utf-8'));
}
function writeApps(apps) {
    const dir = path_1.default.dirname(CONFIG_PATH);
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
    fs_1.default.writeFileSync(CONFIG_PATH, JSON.stringify(apps, null, 2));
}
function readDatabases() {
    if (!fs_1.default.existsSync(DB_CONFIG_PATH))
        return [];
    return JSON.parse(fs_1.default.readFileSync(DB_CONFIG_PATH, 'utf-8'));
}
function writeDatabases(databases) {
    fs_1.default.writeFileSync(DB_CONFIG_PATH, JSON.stringify(databases, null, 2));
}
