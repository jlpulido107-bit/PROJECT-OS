# syntax=docker/dockerfile:1
# PROJECT-OS V1.3 — imagen del dashboard (Next.js standalone, Node 22, usuario no root).
# Construcción: ver docs/despliegue-privado-v1-3.md. La imagen NO contiene secretos ni claves:
# toda la configuración llega en tiempo de ejecución (Cloud Run + Secret Manager).

# Imagen base fijada por digest. Para usar el espejo de Google (p. ej. en Cloud Build o si Docker Hub
# limita descargas): --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22.23.3-bookworm-slim@sha256:…
ARG NODE_IMAGE=docker.io/library/node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# Instalación reproducible desde el lockfile, sin scripts de instalación de terceros.
# `extra_ca` (opcional) es la CA de un proxy corporativo que intercepta TLS; se monta solo durante
# este paso y no queda en ninguna capa: docker build --secret id=extra_ca,src=/ruta/ca.pem …
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080
# Archivos de la aplicación propiedad de root (solo lectura para el proceso); solo la caché de
# Next es escribible por el usuario sin privilegios.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 8080
CMD ["node", "server.js"]
