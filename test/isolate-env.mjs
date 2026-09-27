// Loaded by `npm test` before the runner spawns test files. Tests write and prune the
// fetched-content cache, so a cache root exported in the shell must never reach them.
delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
