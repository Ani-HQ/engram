#!/usr/bin/env bash
# Run TLC on the engram memory / routing and dream-lock specs.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
JAR="${TLA2TOOLS_JAR:-/tmp/tla2tools.jar}"
URL="${TLA2TOOLS_URL:-https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar}"
OUT="$DIR/tlc-out"
WORKERS="${TLC_WORKERS:-2}"

if [[ ! -f "$JAR" ]]; then
  echo "downloading tla2tools.jar → $JAR"
  curl -fsSL -o "$JAR" "$URL"
fi

mkdir -p "$OUT"

run() {
  local spec="$1"
  local cfg="$2"
  local name="$3"
  echo "======== TLC $name ========"
  java -XX:+UseParallelGC -jar "$JAR" \
    -workers "$WORKERS" \
    -config "$DIR/$cfg" \
    -metadir "/tmp/tlc-$name" \
    -noGenerateSpecTE \
    -deadlock \
    "$DIR/$spec" | tee "$OUT/$name.txt"
}

run EngramMemory.tla EngramMemory.cfg memory-cross-roll
run EngramMemory.tla EngramMemoryNoRoll.cfg memory-cross-noroll
run EngramMemory.tla EngramMemoryLiveness.cfg memory-liveness
run EngramMemory.tla EngramMemoryInProcess.cfg memory-inprocess
run EngramDreamLock.tla EngramDreamLock.cfg dream-lock
run EngramDreamLock.tla EngramDreamLockSamePool.cfg dream-lock-same-pool

echo "======== done. stdout in $OUT ========"
