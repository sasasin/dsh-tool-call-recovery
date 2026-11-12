# Contributing

Report the DSH version, plugin version, session mode, and a small sanitized example when reporting a problem. Do not include API keys, private conversation logs, or machine-specific paths.

For changes, explain the behavior being fixed and run:

```sh
npm ci
npm test
npm pack --dry-run
```

Changes to recovery or DSH integration should also run `npm run test:dsh` with a compatible `dsh` on `PATH`. This test uses temporary profiles and a local scripted API. Keep generated `test-results/` files out of commits and state which checks you actually ran.

Please open an issue before proposing a broad change to detection or execution policy. The plugin must continue to request regeneration through DSH rather than execute assistant text itself.
