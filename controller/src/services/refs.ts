import { readDatabases, readApps } from '../config.js';

export interface LocalRef {
  name: string;
  internalPort: number;
  hostPort?: number;
  type: 'app' | 'database';
}

export function resolveLocalRef(name: string): LocalRef | null {
  // Check databases first
  const databases = readDatabases();
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
  const apps = readApps();
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

export function getInternalUrl(name: string, protocol: string = 'http'): string {
  const ref = resolveLocalRef(name);
  if (!ref) return name; 
  return `${protocol}://${ref.name}:${ref.internalPort}`;
}
