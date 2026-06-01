import Fastify from 'fastify';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import simpleGit from 'simple-git';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const GITHUB_SECRET = process.env.GITHUB_SECRET || '';
const CONFIG_PATH = process.env.CONFIG_PATH || './config/apps.json';
const BUILDS_DIR = process.env.BUILDS_DIR || './builds';
const QUADLET_DIR = process.env.QUADLET_DIR || '/home/deploy/.config/containers/systemd';

const fastify = Fastify({ logger: true });

interface AppConfig {
  name: string;
  repo: string;
  domain: string;
  port: number;
  env?: Record<string, string>;
  volumes?: string[];
}

const verifySignature = (payload: string, signature: string) => {
  const hmac = crypto.createHmac('sha256', GITHUB_SECRET);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
};

fastify.post('/webhook', async (request, reply) => {
  const signature = request.headers['x-hub-signature-256'] as string;
  if (!signature || !verifySignature(JSON.stringify(request.body), signature)) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  const payload: any = request.body;
  const repoUrl = payload.repository.clone_url;
  
  // Load config
  const config: AppConfig[] = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const app = config.find(a => a.repo === repoUrl);

  if (!app) {
    return reply.send({ message: 'Repo not managed' });
  }

  fastify.log.info(`Building ${app.name}...`);
  
  try {
    const buildPath = path.join(BUILDS_DIR, app.name);
    const git = simpleGit();

    if (!fs.existsSync(buildPath)) {
      await git.clone(app.repo, buildPath);
    } else {
      await git.cwd(buildPath).pull();
    }

    const commitHash = execSync('git rev-parse --short HEAD', { cwd: buildPath }).toString().trim();
    const imageName = `localhost/${app.name}:${commitHash}`;

    // Podman Build
    fastify.log.info(`Starting podman build for ${imageName}`);
    execSync(`podman build -t ${imageName} .`, { cwd: buildPath, stdio: 'inherit' });

    // Generate Quadlet
    const quadletContent = `
[Unit]
Description=PaaS App ${app.name}
After=network-online.target

[Container]
Image=${imageName}
ContainerName=${app.name}
Network=proxy-net
${app.volumes?.map(v => `Volume=${v}`).join('\n') || ''}
${Object.entries(app.env || {}).map(([k, v]) => `Environment=${k}=${v}`).join('\n')}

# Traefik Labels
Label=traefik.enable=true
Label=traefik.http.routers.${app.name}.rule=Host(\`${app.domain}\`)
Label=traefik.http.routers.${app.name}.entrypoints=websecure
Label=traefik.http.routers.${app.name}.tls.certresolver=letsencrypt
Label=traefik.http.services.${app.name}.loadbalancer.server.port=${app.port}

[Service]
Restart=always

[Install]
WantedBy=default.target
`.trim();

    fs.writeFileSync(path.join(QUADLET_DIR, `${app.name}.container`), quadletContent);

    // Reload systemd
    execSync('systemctl --user daemon-reload');
    execSync(`systemctl --user restart ${app.name}`);

    return { message: 'Deployed successfully', image: imageName };
  } catch (err: any) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Deploy failed', details: err.message });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
