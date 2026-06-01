# Servidor-Jair: Infraestructura Multi-Dominio SaaS-Ready

Esta versión de la infraestructura soporta múltiples dominios de clientes con HTTPS automático, seguridad avanzada y aislamiento de servicios.

## Características Avanzadas

- **Multi-Dominio Dinámico**: Traefik gestiona certificados y routing basado en Hostname automáticamente.
- **Seguridad HTTP**: Headers de seguridad (HSTS, XSS protection, etc.) aplicados globalmente.
- **Protección de Servicios Internos**: Prometheus, Grafana y el Dashboard de Traefik están protegidos por **Basic Auth** adicional y no son públicos.
- **Rate Limiting**: Protección básica contra ataques de fuerza bruta o abuso.
- **Apps Aisladas**: Estructura lista para desplegar múltiples apps Node.js rootless.

## Gestión de Clientes y Dominios

### 1. Configuración DNS del Cliente
Para cada nuevo dominio (ej. `cliente.com`), el cliente debe configurar:

| Tipo | Host | Valor | Nota |
| :--- | :--- | :--- | :--- |
| **A** | `@` | `IP_DEL_SERVIDOR` | Apunta el dominio principal |
| **CNAME** | `www` | `cliente.com.` | Opcional: para el subdominio www |
| **A** | `app` | `IP_DEL_SERVIDOR` | Para subdominios específicos |

### 2. Agregar un Nuevo Cliente en Ansible
Edita `ansible/roles/apps/defaults/main.yml` y añade el nuevo servicio:

```yaml
apps:
  - name: app-cliente-x
    domain: cliente-x.com
    image: tu-imagen-node:latest
    port: 3000
```

Luego ejecuta el playbook:
```bash
ansible-playbook ansible/site.yml
```

Traefik detectará el nuevo contenedor de Podman, solicitará el certificado TLS a Let's Encrypt y configurará el routing en segundos.

## Acceso a Servicios Internos

Los servicios de administración están protegidos. Por defecto:

- **Traefik Dashboard**: `https://traefik.TU_IP.nip.io`
- **Prometheus**: `https://prometheus.tudominio.com`
- **Grafana**: `https://grafana.tudominio.com`

**Credenciales Traefik/Prometheus (Basic Auth):**
- Usuario: `admin`
- Password: `admin` (Cámbialo en `roles/traefik/defaults/main.yml` usando `htpasswd`)

## Mantenimiento de Certificados

Let's Encrypt renovará los certificados automáticamente 30 días antes de su expiración. Los certificados se almacenan en el host en:
`/home/deploy/traefik/acme/acme.json`

### Middleware de Seguridad
Todos los servicios se benefician de los siguientes middlewares globales definidos en `dynamic_conf.yml`:
- `global-security-headers`: HSTS, Frame protection.
- `global-ratelimit`: 100 req/s promedio, 50 burst.

## Operación con Quadlets

Cada app es un servicio systemd independiente:

```bash
# Ver estado de una app de cliente
sudo -u deploy systemctl --user status app-cliente-x

# Ver logs en tiempo real
sudo -u deploy journalctl --user -u app-cliente-x -f
```
