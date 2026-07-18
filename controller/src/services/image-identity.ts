import fs from 'fs';
import path from 'path';
import { podmanRequest } from './podman.js';

/**
 * Identidad de ejecución declarada por una imagen OCI. Se deriva
 * exclusivamente de Config.User / Config.WorkingDir del manifest —
 * el único contrato válido para cualquier imagen, sea cual sea el
 * builder que la generó (CNB, Dockerfile/Buildah, o pulled de un
 * registry externo).
 *
 * Esta es la ÚNICA fuente de verdad de identidad en todo el controller.
 * Ningún otro módulo debe inspeccionar rutas, nombres de builder, ni
 * variables de entorno de builders concretos para decidir identidad.
 */
export interface ImageIdentity {
  /** Valor crudo de Config.User tal como lo declara la imagen ("", "1002", "1002:1000", "app") */
  user: string;
  uid: string | null;
  gid: string | null;
  workingDir: string | null;
}

function parseUser(user: string): { uid: string | null; gid: string | null } {
  if (!user) return { uid: null, gid: null };
  const [uid, gid] = user.split(':');
  return { uid: uid || null, gid: gid ?? null };
}

interface OciConfigBlob {
  config?: { User?: string; WorkingDir?: string };
}

function readOciConfigBlob(imageLayoutDir: string): OciConfigBlob {
  const indexPath = path.join(imageLayoutDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `No se encontró ${indexPath}: el layout OCI no existe o está incompleto`
    );
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
    manifests?: Array<{ digest: string }>;
  };
  const manifestDigest = index.manifests?.[0]?.digest;
  if (!manifestDigest) {
    throw new Error(`No se encontró el digest del manifest en ${indexPath}`);
  }

  const [mAlgo, mHash] = manifestDigest.split(':');
  const manifestPath = path.join(imageLayoutDir, 'blobs', mAlgo, mHash);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No se encontró el blob del manifest en ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    config?: { digest: string };
  };
  const configDigest = manifest.config?.digest;
  if (!configDigest) {
    throw new Error(`No se encontró el digest de configuración en ${manifestPath}`);
  }

  const [cAlgo, cHash] = configDigest.split(':');
  const configPath = path.join(imageLayoutDir, 'blobs', cAlgo, cHash);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No se encontró el blob de configuración en ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as OciConfigBlob;
}

/**
 * Resuelve la identidad de una imagen a partir de su OCI layout en disco,
 * ANTES de que esa imagen exista como tal en el storage de Podman.
 * Se usa durante el build (CNB) para leer la identidad del run-image ya
 * sembrado en el layout, y así hacer coincidir el ownership de los
 * archivos exportados con el usuario que la imagen final va a usar.
 *
 * No hardcodea ninguna ruta de aplicación. Falla explícitamente (no cae
 * a un fallback silencioso) si el layout está incompleto o corrupto,
 * porque un fallback silencioso aquí es exactamente el tipo de bug que
 * generó el EACCES original: usar una identidad equivocada sin que nadie
 * se entere.
 */
export function resolveIdentityFromOciLayout(imageLayoutDir: string): ImageIdentity {
  const blob = readOciConfigBlob(imageLayoutDir);
  const user = blob.config?.User ?? '';
  const { uid, gid } = parseUser(user);
  return {
    user,
    uid,
    gid,
    workingDir: blob.config?.WorkingDir || null,
  };
}

/**
 * Resuelve la identidad de una imagen YA cargada en el storage de Podman,
 * consultando su Config.User/Config.WorkingDir vía la API remota.
 * Uso previsto: auditoría/logging del deploy. NO se usa para forzar un
 * `User=` en runtime — Podman ya aplica Config.User de la imagen por
 * defecto al crear el contenedor sin overrides.
 */
export async function resolveIdentityFromLoadedImage(
  imageName: string
): Promise<ImageIdentity> {
  const { status, data } = await podmanRequest(
    'GET',
    `/v5.0.0/libpod/images/${encodeURIComponent(imageName)}/json`
  );
  if (status !== 200) {
    throw new Error(`No se pudo inspeccionar la imagen "${imageName}" (status ${status})`);
  }
  const info = data as { Config?: { User?: string; WorkingDir?: string } };
  const user = info.Config?.User ?? '';
  const { uid, gid } = parseUser(user);
  return {
    user,
    uid,
    gid,
    workingDir: info.Config?.WorkingDir || null,
  };
}
