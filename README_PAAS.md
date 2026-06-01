# Modern Mini-PaaS Platform (servidor-jair)

Esta infraestructura ha sido evolucionada hacia una plataforma tipo PaaS autohospedada que automatiza el despliegue de aplicaciones Node.js (y otras) mediante Git, Podman y Traefik.

## Arquitectura

- **Controller (Node.js/TS):** Escucha webhooks de GitHub, realiza el build de imágenes con Podman/Buildah y genera archivos Quadlet.
- **Orquestación (Systemd Quadlets):** Las aplicaciones se gestionan como servicios de sistema nativos, permitiendo auto-restart y gestión de dependencias.
- **Routing (Traefik):** Detección automática de nuevos contenedores y provisión de certificados TLS (Let's Encrypt).
- **Seguridad:** Todo corre en modo **rootless** bajo el usuario `deploy`, con SELinux habilitado.

## Cómo agregar una nueva aplicación

1.  **Configurar el Controller:**
    Edita `ansible/roles/paas-controller/defaults/main.yml` o el archivo `apps.json` en el servidor:
    ```json
    {
      "name": "mi-app-node",
      "repo": "https://github.com/usuario/mi-app.git",
      "domain": "app.midominio.com",
      "port": 3000,
      "env": {
        "NODE_ENV": "production"
      }
    }
    ```

2.  **Configurar Webhook en GitHub:**
    - Payload URL: `https://deploy.midominio.com/webhook`
    - Content type: `application/json`
    - Secret: El valor configurado en `controller_github_secret`.

3.  **Hacer Push:**
    Al hacer `git push`, el controlador:
    - Clonará el repo.
    - Construirá la imagen (usando el `Dockerfile` del repo).
    - Creará el servicio systemd.
    - Reiniciará la app sin downtime (Traefik esperará al healthcheck).

## Operaciones Comunes

### Ver logs de una aplicación
```bash
journalctl --user -u mi-app-node -f
```

### Ver logs del controlador
```bash
journalctl --user -u paas-controller -f
```

### Reiniciar manualmente una app
```bash
systemctl --user restart mi-app-node
```

### Troubleshooting de builds
Los builds ocurren en `/home/deploy/paas-controller/builds/`. Puedes entrar ahí y ejecutar `podman build .` manualmente para diagnosticar errores de compilación.

## Monitoreo
- **Grafana:** Dashboard de Podman Containers (vía Podman Exporter).
- **Alertmanager:** Alertas si el controlador o una app crítica dejan de responder.
