# Servidor-Jair: Infraestructura Moderna & Mini-PaaS (Podman 5 & Ansible)

Este proyecto automatiza la configuración de un servidor dedicado basado en **AlmaLinux 10** o **Rocky Linux 10** evolucionado hacia una plataforma **Mini-PaaS autohospedada** utilizando **Podman 5**, **Quadlets** y **Traefik**.

---

## 🚀 Características Principales

- **Arquitectura Mini-PaaS**: Despliegues automáticos al hacer `git push`.
- **Seguridad Nativa**: Rootless Podman 5, SELinux Enforcing, Firewalld y SSH hardening.
- **Orquestación**: Integración con **systemd** mediante **Quadlets** (soporte completo Podman 5).
- **Runtime**: **Node.js 22 LTS** para el controlador de despliegues.
- **Monitoreo Full-Stack**: Prometheus, Grafana, Alertmanager y exportadores (Node & Podman).
- **Inmutabilidad**: Despliegues basados en SHA de Git para facilitar rollbacks.

---

## 🏗️ Arquitectura del Sistema

### Componentes Core
- **Deploy Controller (Node.js/TS)**: El "cerebro" que escucha webhooks de GitHub, construye imágenes y orquestra los servicios.
- **Traefik Ingress**: Gestiona el tráfico HTTP/S, rate limiting y certificados TLS.
- **Podman Engine**: Ejecuta contenedores sin privilegios de root (rootless).
- **Systemd**: Gestiona el ciclo de vida de los contenedores como servicios del sistema.

### Estructura del Repositorio
```text
.
├── ansible/               # Gestión de infraestructura base
│   ├── roles/             # Roles modulares (common, podman, traefik, paas-controller)
│   └── site.yml           # Playbook principal
├── controller/            # Código fuente del PaaS Controller (TypeScript)
├── README.md              # Esta guía consolidada
└── README_*.md            # (Legacy) Documentación específica por módulo
```

---

## 🛠️ Guía de Inicio Rápido

### 1. Requisitos Previos
- Servidor con **Rocky/AlmaLinux 9**.
- Acceso SSH por llave pública.
- Ansible instalado localmente:
  ```bash
  ansible-galaxy collection install containers.podman
  ```

### 2. Configuración Inicial
1. Edita `ansible/inventory/hosts.yml` con la IP de tu servidor.
2. Configura los secretos en `ansible/roles/*/defaults/main.yml` (se recomienda usar Ansible Vault).
3. Ejecuta el despliegue base:
   ```bash
   cd ansible && ansible-playbook site.yml
   ```

---

## 📦 Gestión de Aplicaciones (PaaS Workflow)

### Cómo agregar una nueva aplicación
1. **Configurar en el PaaS Controller**:
   Edita `apps.json` en el servidor o vía Ansible:
   ```json
   {
     "name": "mi-app-node",
     "repo": "https://github.com/usuario/repo.git",
     "domain": "app.midominio.com",
     "port": 3000,
     "env": { "NODE_ENV": "production" }
   }
   ```
2. **Configurar Webhook en GitHub**:
   - URL: `https://deploy.midominio.com/webhook`
   - Content-type: `application/json`
   - Secret: El valor de `controller_github_secret`.
3. **Git Push**: Al subir cambios, la plataforma detectará el cambio, construirá la imagen y hará el "swap" sin downtime apreciable.

---

## 🔐 Seguridad y Networking

- **Rootless**: Todos los servicios corren bajo el usuario `deploy` (UID 1001+).
- **Firewalld**: Solo los puertos 80, 443 y 22 están abiertos.
- **TLS**: Let's Encrypt gestiona los certificados. Para dominios wildcard, se recomienda configurar el **DNS-01 Challenge**.
- **Rate Limiting**: Aplicado globalmente (100 req/s promedio) vía Traefik.

---

## 📊 Monitoreo y Operaciones

### Acceso a Dashboards (Protegidos por Basic Auth)
- **Grafana**: `https://grafana.tudominio.com`
- **Prometheus**: `https://prometheus.tudominio.com`
- **Traefik**: `https://traefik.TU_IP.nip.io`

### Comandos de Utilidad (SSH)
```bash
# Ver estado de todas las apps
sudo -u deploy podman ps

# Ver logs de una app específica
sudo -u deploy journalctl --user -u mi-app-node -f

# Logs del controlador de deploys
sudo -u deploy journalctl --user -u paas-controller -f

# Reiniciar manualmente una app
sudo -u deploy systemctl --user restart mi-app-node
```

---

## 🔄 Inmutabilidad y Rollbacks

Cada despliegue etiqueta la imagen con el commit SHA de Git. Si un deploy falla:
1. Identifica el SHA anterior estable.
2. Actualiza la configuración de la app con el SHA deseado.
3. Reinicia el servicio. La plataforma garantiza que el tráfico no rote hasta que el **Healthcheck** del nuevo contenedor sea exitoso.

---

## 🤝 Contribución y Mantenimiento

- **Actualizar el Controlador**: Modifica el código en `controller/` y ejecuta el playbook de Ansible.
- **Añadir Nodos**: La infraestructura es modular; puedes escalar añadiendo hosts al inventario y asignando roles específicos.
