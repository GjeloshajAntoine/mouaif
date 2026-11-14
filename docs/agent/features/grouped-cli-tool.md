# Grouped CLI tool

`group_cli` stays available alongside `shell`: ordered commands, per-entry results and async entries. Async results provide PID, log paths and shell inspect/wait/stop commands, never model job handles. See [full documentation](../../features/grouped-cli-tool.md).

## Notes from the public page

Both command tools use the same background runner, bounded log and process-group cleanup. Background processes stop on app shutdown. Scheduled wakes are time-only.
