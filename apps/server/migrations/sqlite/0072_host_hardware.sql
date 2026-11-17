-- The hardware a host's connector last reported on its own callback (POST /api/connectors/self/hardware, see
-- docs/design/host-placement.md and packages/shared/src/hardware.ts): operating system, CPU, memory, disk, GPUs and load,
-- which host pages show and placement of sub-task sessions reads, and when it arrived. NULL for connectors that report none.
ALTER TABLE connectors ADD COLUMN hardware_json TEXT;
ALTER TABLE connectors ADD COLUMN hardware_at TEXT;
