import fs from 'fs';
import path from 'path';
import { AppConfig, DatabaseConfig } from './types.js';

const CONFIG_PATH = process.env.CONFIG_PATH || './config/apps.json';
const DB_CONFIG_PATH = process.env.DB_CONFIG_PATH ||
  path.join(path.dirname(CONFIG_PATH), 'databases.json');

export function readApps(): AppConfig[] {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

export function readDatabases(): DatabaseConfig[] {
  if (!fs.existsSync(DB_CONFIG_PATH)) return [];
  return JSON.parse(fs.readFileSync(DB_CONFIG_PATH, 'utf-8'));
}

export function writeDatabases(databases: DatabaseConfig[]): void {
  fs.writeFileSync(DB_CONFIG_PATH, JSON.stringify(databases, null, 2));
}

export { CONFIG_PATH, DB_CONFIG_PATH };
