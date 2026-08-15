# engram: gateway + pinned gbrain in one image.
FROM oven/bun:1-debian

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 \
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

ADD https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.2/cloud-sql-proxy.linux.amd64 /usr/local/bin/cloud-sql-proxy
RUN chmod +x /usr/local/bin/cloud-sql-proxy

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY gateway ./gateway
COPY cli ./cli
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# gbrain auto-loads .env.local from cwd (dotenv) — keep the workdir guaranteed clean.
RUN rm -f .env.local

ENV GBRAIN_HOMES_DIR=/gbrain-homes
ENV PORT=8080
EXPOSE 8080
CMD ["/usr/local/bin/entrypoint.sh"]
