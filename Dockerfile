# engram: gateway + pinned gbrain in one image.
FROM oven/bun:1-debian

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# gbrain, from our mirror, pinned. Bump GBRAIN_COMMIT deliberately — never build from HEAD.
ARG GBRAIN_REPO=https://github.com/Ani-HQ/gbrain.git
ARG GBRAIN_COMMIT=4922905fb970d7014625a0190136fbfc8a4f36b0
RUN git clone ${GBRAIN_REPO} /opt/gbrain \
  && git -C /opt/gbrain checkout ${GBRAIN_COMMIT} \
  && cd /opt/gbrain && bun install --frozen-lockfile && bun link
ENV GBRAIN_BIN=/root/.bun/bin/gbrain

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY gateway ./gateway
COPY cli ./cli

# gbrain auto-loads .env.local from cwd (dotenv) — keep the workdir guaranteed clean.
RUN rm -f .env.local

ENV GBRAIN_HOMES_DIR=/gbrain-homes
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "gateway/src/index.ts"]
