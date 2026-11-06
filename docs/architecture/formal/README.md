# Formal model of engram memory and routing

TLA+ specs for the live remember/recall path and the dream advisory lock.
They describe the code; they do not change it.

## Requirements

- Java 11+
- [tla2tools.jar](https://github.com/tlaplus/tlaplus/releases) (tested with 1.8.0)

```bash
cd docs/architecture/formal
./run-tlc.sh
```

`run-tlc.sh` downloads the jar into `/tmp` if needed and writes TLC stdout
under `tlc-out/`.

## What is checked

| Config | Models | Expectation |
| --- | --- | --- |
| `EngramMemory.cfg` | Two replicas, rollover on | `AckedWritePresent` violated |
| `EngramMemoryNoRoll.cfg` | Two replicas, no rollover | `AckedWritePresent` violated |
| `EngramMemoryLiveness.cfg` | Two replicas, no ack invariant | termination holds |
| `EngramMemoryInProcess.cfg` | One replica, both writers queued | all invariants hold |
| `EngramDreamLock.cfg` | Two jobs, two pools | `LockReleasedWhenIdle` violated |
| `EngramDreamLockSamePool.cfg` | Two jobs, one pool | `AtMostOneRunning` violated |

The in-process run is the control: the same invariant that fails across
replicas holds when `serializeBySlug` can see both writers.

Findings from a real TLC run are in [../findings.md](../findings.md).
