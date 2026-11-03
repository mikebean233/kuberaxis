# Kuberaxis Helm chart

Helm chart for deploying Kuberaxis to Kubernetes.

> **Status:** early work in progress. Kuberaxis does not publish container images yet, so the default image
> repositories in `values.yaml` are placeholders.

## What gets deployed

The chart runs three components from this repo:

| Component | Source | Notes |
| --- | --- | --- |
| API | [`apps/api`](../../apps/api) | Fastify + Postgres. Applies database migrations on start. |
| Web | [`apps/web`](../../apps/web) | React + Vite single-page app; calls the API under `/api`. |
| Database | — | PostgreSQL 18 (matches the [`docker-compose.yml`](../../docker-compose.yml) used for local development). |

In local development Vite proxies `/api` to the API. In the cluster, the web app and the API should sit behind the
same host, with `/api` routed to the API service and everything else to the web service.

## Prerequisites

- Kubernetes cluster and `kubectl` access
- [Helm](https://helm.sh/) 3
- Container images for the API and web app (Kuberaxis does not publish any yet). The web image is expected to
  serve the built SPA on port 8080 (`web.port`).

## Installation

```sh
helm install kuberaxis ./charts/kuberaxis \
  --set api.image.repository=<registry>/kuberaxis-api \
  --set web.image.repository=<registry>/kuberaxis-web
```

Image tags default to the chart's `appVersion`; override with `api.image.tag` / `web.image.tag`. With no other
settings this uses the bundled database and no Ingress.

## Database

Choose one of two paths with `postgresql.enabled`.

### Bundled PostgreSQL (default)

A single-replica PostgreSQL 18 StatefulSet (official `postgres` image) with an 8Gi PersistentVolumeClaim.

```yaml
postgresql:
  enabled: true
  auth:
    username: kuberaxis
    database: kuberaxis
    password: ""          # empty: generate one and keep it across upgrades
    existingSecret: ""    # or read the password from your own Secret
    existingSecretPasswordKey: password
  persistence:
    size: 8Gi
    storageClass: ""
```

The generated password Secret is annotated `helm.sh/resource-policy: keep`, and StatefulSet volumes are never
deleted by Helm, so `helm uninstall` leaves both behind. A reinstall with the same release name picks up the old
data and password. Delete the Secret and the `data-<release>-kuberaxis-postgresql-0` PVC to start fresh.

### External PostgreSQL

```yaml
postgresql:
  enabled: false
externalDatabase:
  host: db.example.com
  port: 5432
  username: kuberaxis
  database: kuberaxis
  password: ""            # or:
  existingSecret: kuberaxis-db
  existingSecretPasswordKey: password
  sslMode: verify-full    # optional
```

`host` and one of `password` / `existingSecret` are required; the chart fails to render without them. The user
needs rights to create tables, since the API applies its migrations on start.

### How the API connects

The API gets `DATABASE_URL` without a password, plus `PGPASSWORD` from the Secret. node-postgres reads
`PGPASSWORD` when the URL has none, so passwords with special characters need no URL encoding.

## Ingress

The web UI calls the API at `/api` on the same host, so for each configured host the Ingress routes `/api` to the
API service and `/` to the web service.

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    # Statement uploads can be up to 25 MiB; ingress-nginx defaults to 1m.
    nginx.ingress.kubernetes.io/proxy-body-size: 25m
  hosts:
    - host: kuberaxis.example.com
  tls:
    - secretName: kuberaxis-tls
      hosts:
        - kuberaxis.example.com
```

Without an Ingress there is no single host serving both, so the UI won't work through a plain port-forward.

## API configuration

The chart sets the API's environment variables ([`apps/api/src/config.ts`](../../apps/api/src/config.ts)):

| Variable | Set from | Notes |
| --- | --- | --- |
| `HOST` | always `0.0.0.0` | The app defaults to `127.0.0.1`, which is unreachable from the Service. |
| `PORT` | `api.port` (3001) | |
| `NODE_ENV` | `api.nodeEnv` (`production`) | `production` disables `DELETE /api/data`, which wipes all data. |
| `DATABASE_URL` | database settings above | No password; see [How the API connects](#how-the-api-connects). |
| `PGPASSWORD` | database Secret | |

Add more with `api.extraEnv`. Readiness checks `GET /api/health`, which queries the database; liveness is a TCP
check so a database outage doesn't restart the API.

## Development

Run from the repo root:

```sh
helm lint charts/kuberaxis
helm template kuberaxis charts/kuberaxis | kubeconform -strict -summary
helm template kuberaxis charts/kuberaxis --set postgresql.enabled=false \
  --set externalDatabase.host=db --set externalDatabase.password=x
```
