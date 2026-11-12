# Changelog

## 1.0.0 - 2026-11-12

Initial public release.

- Detect supported XML tool calls emitted as assistant text at the turn's stop boundary.
- Ask the model to regenerate calls through DSH without executing text directly.
- Keep consecutive and whole-turn retry limits, reset the consecutive count on successful tool results, and reconstruct counts from session history.
- Skip Markdown examples and responses containing structured tool calls.
- Ship a build-free DSH bundle with configuration, unit tests, and isolated integration tests.
