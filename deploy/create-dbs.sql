-- Compose-only bootstrap: shared brain database + gateway database.
-- (On Cloud SQL, deploy/setup-gcp.sh creates these instead.)
CREATE DATABASE brain_shared;
CREATE DATABASE engram_gateway;
