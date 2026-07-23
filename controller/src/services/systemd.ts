import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const execFileAsync = promisify(execFile);

const QUADLET_DIR = process.env.QUADLET_DIR || '/quadlets';

interface SystemctlError {
  stdout?: string;
  stderr?: string;
  message: string;
}

async function systemctl(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', ...args], {
      maxBuffer: 1024 * 1024 * 10,
    });
    return stdout;
  } catch (err) {
    const e = err as SystemctlError;
    throw new Error(`systemctl ${args.join(' ')} failed: ${e.stderr || e.message}`);
  }
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Escribe el archivo .container solo si el contenido cambió. Devuelve true
 * si hubo escritura (y por lo tanto se requiere daemon-reload real), false
 * si el archivo ya estaba idéntico.
 */
export function writeQuadletIfChanged(unitFileName: string, content: string): boolean {
  const filePath = path.join(QUADLET_DIR, unitFileName);
  const normalized = content.trim() + '\n';

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (hashContent(existing) === hashContent(normalized)) {
      return false;
    }
  }

  fs.writeFileSync(filePath, normalized);
  return true;
}

export function removeQuadletFile(unitFileName: string): void {
  const filePath = path.join(QUADLET_DIR, unitFileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export async function daemonReloadUser(): Promise<void> {
  await systemctl(['daemon-reload']);
}

export async function restartUnit(unitName: string): Promise<void> {
  await systemctl(['restart', unitName]);
}

export async function stopUnit(unitName: string): Promise<void> {
  try {
    await systemctl(['stop', unitName]);
  } catch {
    // Si la unidad no existía o ya estaba detenida, no es un error fatal.
  }
}

export async function disableUnit(unitName: string): Promise<void> {
  try {
    await systemctl(['disable', unitName]);
  } catch {
    // Nada que deshabilitar — está bien.
  }
}

export interface UnitStatus {
  activeState: string;
  subState: string;
}

export async function getUnitStatus(unitName: string): Promise<UnitStatus> {
  const stdout = await systemctl([
    'show',
    unitName,
    '--property=ActiveState,SubState',
  ]);

  const props: Record<string, string> = {};
  for (const line of stdout.trim().split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    props[line.slice(0, idx)] = line.slice(idx + 1);
  }

  return {
    activeState: props.ActiveState || 'unknown',
    subState: props.SubState || 'unknown',
  };
}

export async function waitForActive(
  unitName: string,
  timeoutMs = 30_000,
  intervalMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await getUnitStatus(unitName);

    if (status.activeState === 'active' && status.subState === 'running') return;

    if (status.activeState === 'failed') {
      throw new Error(`Unit ${unitName} entró en estado failed durante el arranque`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timeout esperando a que ${unitName} quede active/running`);
}

/**
 * Único punto de entrada para aplicar un cambio de ciclo de vida:
 * escribe (o actualiza) el Quadlet, recarga systemd, reinicia la unidad,
 * y espera a que quede corriendo. Esta función es la ÚNICA forma en la
 * que el controller debe crear/actualizar/arrancar una app o base de datos
 * gestionada por Quadlet. Nada más debe hablar con Podman para arrancar
 * contenedores.
 */
export async function applyQuadlet(
  unitFileName: string,
  unitName: string,
  content: string,
  log: (msg: string) => void
): Promise<void> {
  const changed = writeQuadletIfChanged(unitFileName, content);
  log(changed ? `Quadlet ${unitFileName} actualizado.` : `Quadlet ${unitFileName} sin cambios.`);

  // Siempre recargamos: aunque el contenido no haya cambiado, puede haber
  // drift (por ejemplo, alguien tocó el archivo a mano, o hubo un restart
  // de systemd sin este proceso). Reload es idempotente y barato.
  await daemonReloadUser();

  log(`Reiniciando ${unitName}...`);
  await restartUnit(unitName);

  log(`Esperando a que ${unitName} quede activo...`);
  await waitForActive(unitName);

  log(`${unitName} está activo.`);
}

/**
 * Único punto de entrada para eliminar por completo una app o base de
 * datos del ciclo de vida gestionado por systemd: detiene la unidad,
 * la deshabilita, borra el Quadlet y recarga.
 */
export async function teardownUnit(
  unitFileName: string,
  unitName: string,
  log: (msg: string) => void
): Promise<void> {
  await stopUnit(unitName);
  await disableUnit(unitName);
  removeQuadletFile(unitFileName);
  await daemonReloadUser();
  log(`${unitName} detenido y Quadlet eliminado.`);
}
