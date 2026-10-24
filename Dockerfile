# engram: gateway + pinned gbrain in one image.
FROM oven/bun:1.3.10-debian

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 util-linux \
  && rm -rf /var/lib/apt/lists/*

# gbrain, from our mirror, pinned. Bump GBRAIN_COMMIT deliberately — never build from HEAD.
ARG GBRAIN_REPO=https://github.com/Ani-HQ/gbrain.git
ARG GBRAIN_COMMIT=4922905fb970d7014625a0190136fbfc8a4f36b0
COPY deploy/patch-gbrain.py /tmp/patch-gbrain.py
RUN git clone ${GBRAIN_REPO} /opt/gbrain \
  && git -C /opt/gbrain checkout ${GBRAIN_COMMIT} \
  && python3 /tmp/patch-gbrain.py /opt/gbrain/src/core/migrate.ts \
  && cd /opt/gbrain && bun install --frozen-lockfile \
  && printf '#!/bin/sh\nexec bun /opt/gbrain/src/cli.ts "$@"\n' > /usr/local/bin/gbrain \
  && chmod +x /usr/local/bin/gbrain
ENV GBRAIN_BIN=/usr/local/bin/gbrain

# Optimistic concurrency is enforced by PostgreSQL before importer side effects.
# The patch verifies exact upstream files and refuses an unreviewed engine bump.
COPY deploy/patch-gbrain-cas.py /tmp/patch-gbrain-cas.py
RUN python3 /tmp/patch-gbrain-cas.py /opt/gbrain/src

ARG TARGETARCH
ARG CLOUD_SQL_PROXY_VERSION=2.14.2
# BuildKit supplies TARGETARCH for native amd64 and arm64 builds. The proxy is
# dormant on self-hosted installs unless ENGRAM_CLOUDSQL_INSTANCE is configured.
ADD https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v${CLOUD_SQL_PROXY_VERSION}/cloud-sql-proxy.linux.${TARGETARCH} /usr/local/bin/cloud-sql-proxy
# Checksums published with https://github.com/GoogleCloudPlatform/cloud-sql-proxy/releases/tag/v2.14.2
RUN case "$TARGETARCH" in \
      amd64) proxy_sha=2f819e6e47e9026fa467cf55ca88eb674c698f8a93aecf940a364b4432c933f5 ;; \
      arm64) proxy_sha=c26d80b492002dfc6d525a0f2af60fbdf0c3873fd310fe1f1dba22a32663035b ;; \
      *) echo "Unsupported Cloud SQL proxy architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && printf '%s  %s\n' "$proxy_sha" /usr/local/bin/cloud-sql-proxy | sha256sum -c - \
  && chmod 0755 /usr/local/bin/cloud-sql-proxy

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
  && bun -e 'import { Resvg } from "@resvg/resvg-js"; const png = new Resvg("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"></svg>").render().asPng(); if (png.length < 8) throw new Error("PNG renderer unavailable");'
COPY gateway ./gateway
COPY cli ./cli
COPY web ./web
COPY shim ./shim
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/runtime-entrypoint.sh /usr/local/bin/engram-runtime
COPY deploy/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
COPY deploy/cloudrun-worker.py /usr/local/bin/cloudrun-worker
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/engram-runtime /usr/local/bin/worker-entrypoint /usr/local/bin/cloudrun-worker \
  && test "$(id -u bun):$(id -g bun)" = "1000:1000" \
  && test -x /usr/bin/setpriv

# gbrain auto-loads .env.local from cwd (dotenv) — keep the workdir guaranteed clean.
RUN rm -f .env.local \
  && mkdir -p /gbrain-homes /gbrain-work /sandbox-empty \
  && chown bun:bun /gbrain-homes

ENV GBRAIN_HOMES_DIR=/gbrain-homes
ENV PORT=8080
EXPOSE 8080
# The Cloud Run egress launcher creates veth devices as root. The entrypoint
# drops all other deployment/job paths before starting any database proxy.
USER root
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
