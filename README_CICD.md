# Flujo de CI/CD y Operaciones - Servidor-Jair

Este documento explica cómo funciona el ciclo de vida de una aplicación en la plataforma, desde el código hasta la producción.

## 1. El Flujo de Deployment (Git Push -> Prod)

### Paso A: Desarrollo y Push
El desarrollador trabaja en su app Node.js y hace `git push` a su repositorio.

### Paso B: GitHub Actions (Build)
El workflow de GitHub Actions se activa:
1. Construye una imagen OCI (compatible con Docker/Podman).
2. Etiqueta la imagen con el `GIT_SHA` (para inmutabilidad) y con `latest`.
3. Sube la imagen a **GitHub Container Registry (GHCR)**.

### Paso C: GitHub Actions (Deploy)
Una vez subida la imagen, el workflow llama a Ansible:
1. Ansible se conecta al servidor vía SSH.
2. Actualiza el archivo de Quadlet (`.container`) con la nueva imagen.
3. Ejecuta `systemctl --user daemon-reload`.
4. Reinicia el servicio de la app: `systemctl --user restart app-name`.

### Paso D: Validación (Healthcheck)
1. **Podman** inicia el nuevo contenedor.
2. El **Healthcheck** definido en el Quadlet empieza a verificar `http://localhost:3000/health`.
3. **Traefik**, al estar conectado al socket de Podman, espera a que el contenedor pase el Healthcheck antes de enviarle tráfico real.

---

## 2. Inmutabilidad y Rollbacks

- **Versionado**: Nunca usamos solo `:latest` en producción. Cada deploy usa el `SHA` del commit.
- **Rollback**: Si un deploy falla, simplemente ejecutamos el workflow anterior de GitHub Actions o usamos Ansible para volver a la versión (SHA) anterior.
  ```bash
  ansible-playbook site.yml --extra-vars "app_version=SHA_ANTERIOR" --tags apps
  ```

---

## 3. Manejo de Secretos

- **Secretos de Build**: Se manejan en GitHub Secrets (ej. `GH_TOKEN`).
- **Secretos de App**: 
  - Se definen en `ansible/roles/apps/defaults/main.yml` usando **Ansible Vault** para cifrarlos.
  - Se inyectan como variables de entorno en el Quadlet (`Environment=...`).

---

## 4. Podman vs Docker: Clarificaciones Técnicas

- **Socket**: Usamos `/run/user/<UID>/podman/podman.sock`. Es 100% compatible con el API de Docker que Traefik espera.
- **Rootless**: Todo corre sin privilegios de root, aumentando la seguridad significativamente.
- **Discovery**: Traefik usa el provider `docker` configurado para apuntar al socket de Podman. Detecta los cambios mediante eventos del socket.

---

## 5. Cómo agregar una nueva App desde CERO

1. **En el repo de la App**:
   - Crea un `Dockerfile`.
   - Crea un endpoint `/health` en tu app Node.js.
   - Agrega el workflow de GitHub Actions para build/push.

2. **En este repo de Infraestructura**:
   - Agrega la app a `ansible/roles/apps/defaults/main.yml`:
     ```yaml
     - name: mi-nueva-app
       domain: app.cliente.com
       image: ghcr.io/org/mi-nueva-app:latest
       port: 3000
       env:
         NODE_ENV: production
         DB_URL: "{{ vault_db_url }}"
     ```
   - Ejecuta el playbook.

---

## 6. Operaciones Diarias (SRE/Admin)

### Monitorear Status
```bash
# Ver todas las apps corriendo
sudo -u deploy podman ps

# Ver consumo de recursos
sudo -u deploy podman stats
```

### Ver Logs de un Deployment Fallido
Si la app no inicia:
```bash
sudo -u deploy journalctl --user -u nombre-app -f
```

### Zero Downtime (Consideraciones)
En un servidor único, el "Zero Downtime" es "Minimal Downtime" (el tiempo que tarda en reiniciar el proceso). Para un SaaS real, Traefik ayuda a que la transición sea limpia al esperar el healthcheck antes de rotar el tráfico.
