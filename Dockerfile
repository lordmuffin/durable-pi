# syntax=docker/dockerfile:1.7
# Container images for the homelab fork (lordmuffin/durable-pi). Two targets from one build:
#   docker build --target backend -t ghcr.io/lordmuffin/dpi-backend:<sha> .
#   docker build --target hub     -t ghcr.io/lordmuffin/dpi-playground:<sha> .
# Both run under tsx exactly as upstream's systemd unit does (apps/dpi-backend/deploy/dpi-backend.service).
# The backend image also carries kubectl, flux and velero for the homelab-incident k8s_read tool and the
# velero-restore-drill job, pinned to the k3s2 cluster's versions (k3s v1.36.2, Flux v2.7.5, Velero chart 12.1.0 ~
# v1.18.x server) and verified by SHA-256 (ADD --checksum).
ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY apps/dpi-sdk/package.json apps/dpi-sdk/package-lock.json apps/dpi-sdk/
COPY apps/dpi-backend/package.json apps/dpi-backend/package-lock.json apps/dpi-backend/
COPY apps/dpi-playground/package.json apps/dpi-playground/package-lock.json apps/dpi-playground/
COPY apps/dpi-playground/apps/dpi-playground-fe/package.json apps/dpi-playground/apps/dpi-playground-fe/
COPY apps/dpi-playground/apps/dpi-playground-hub/package.json apps/dpi-playground/apps/dpi-playground-hub/
RUN cd apps/dpi-sdk && npm ci --ignore-scripts \
 && cd ../dpi-backend && npm ci \
 && cd ../dpi-playground && npm ci

FROM deps AS hub-build
COPY apps/dpi-sdk apps/dpi-sdk
COPY apps/dpi-playground apps/dpi-playground
RUN cd apps/dpi-playground && npm run build

FROM ${NODE_IMAGE} AS tools
ARG KUBECTL_VERSION=v1.36.2
ARG FLUX_VERSION=2.7.5
ARG VELERO_VERSION=1.18.4
ADD --checksum=sha256:1e9045ec32bea85da43de85f0065358529ea7c7a152eca78154fba5b58c27d82 \
    https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl /usr/local/bin/kubectl
ADD --checksum=sha256:1e92141e8498289e4b27411385aeb18396053176cf297b0cb99abd6ca8293e75 \
    https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_linux_amd64.tar.gz /tmp/flux.tgz
ADD --checksum=sha256:e520c17d8997e1c9d0a28ae013592e4473ca3bd82cb3acd132e51286263f74bf \
    https://github.com/velero-io/velero/releases/download/v${VELERO_VERSION}/velero-v${VELERO_VERSION}-linux-amd64.tar.gz /tmp/velero.tgz
RUN tar -xzf /tmp/flux.tgz -C /usr/local/bin flux \
 && tar -xzf /tmp/velero.tgz -C /usr/local/bin --strip-components=1 velero-v${VELERO_VERSION}-linux-amd64/velero \
 && chmod 0755 /usr/local/bin/kubectl /usr/local/bin/flux /usr/local/bin/velero

FROM ${NODE_IMAGE} AS backend
# git for interactive sessions' repo work; bash is already in the base image.
ARG EXTRA_PACKAGES="ca-certificates git"
RUN if [ -n "${EXTRA_PACKAGES}" ]; then apt-get update && apt-get install -y --no-install-recommends ${EXTRA_PACKAGES} && rm -rf /var/lib/apt/lists/*; fi
COPY --from=tools /usr/local/bin/kubectl /usr/local/bin/flux /usr/local/bin/velero /usr/local/bin/
WORKDIR /app
COPY --from=deps /app/apps/dpi-sdk/node_modules apps/dpi-sdk/node_modules
COPY --from=deps /app/apps/dpi-backend/node_modules apps/dpi-backend/node_modules
COPY apps/dpi-sdk apps/dpi-sdk
COPY apps/dpi-backend apps/dpi-backend
ENV NODE_ENV=production NODE_NO_WARNINGS=1 HOME=/var/lib/dpi DPI_HOME=/var/lib/dpi DPI_HOST=0.0.0.0 DPI_PORT=4780
USER 10001:10001
WORKDIR /app/apps/dpi-backend
EXPOSE 4780
CMD ["node", "--import", "tsx", "src/main.ts"]

FROM ${NODE_IMAGE} AS hub
WORKDIR /app
COPY --from=deps /app/apps/dpi-sdk/node_modules apps/dpi-sdk/node_modules
COPY --from=deps /app/apps/dpi-playground/node_modules apps/dpi-playground/node_modules
COPY apps/dpi-sdk apps/dpi-sdk
COPY --from=hub-build /app/apps/dpi-playground apps/dpi-playground
ENV NODE_ENV=production NODE_NO_WARNINGS=1 HOME=/var/lib/dpi-hub DPI_HOME=/var/lib/dpi-hub DPI_HUB_HOST=0.0.0.0 DPI_HUB_PORT=4781
USER 10001:10001
WORKDIR /app/apps/dpi-playground
EXPOSE 4781
CMD ["node", "--import", "tsx", "apps/dpi-playground-hub/src/main.ts"]
