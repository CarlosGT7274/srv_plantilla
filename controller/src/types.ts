export interface AppConfig {
  name: string;
  repo: string;
  domain: string;
  port: number;
  private?: boolean;
  github_token?: string;
  env?: Record<string, string>;
  volumes?: string[];
  health_check?: boolean;
  health_path?: string;
}

export type DatabaseType = 'mysql' | 'postgres';

export interface DatabaseConfig {
  name: string;
  type: DatabaseType;
  port?: number;
  host_port?: number;
  env?: Record<string, string>;
  external_access?: boolean;
}

export type ProjectType =
  | 'node-npm' | 'node-pnpm' | 'node-yarn' | 'node-bun'
  | 'python-pip' | 'python-poetry'
  | 'java-maven' | 'java-gradle'
  | 'go' | 'ruby' | 'unknown';
