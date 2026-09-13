# Changelog

## 0.2.0 — 2026-09-13

- Add bounded Lovelace card preview/apply tools with exact before/after, content hashes, stale-version rejection, a final pre-write read and full readback.
- Allow cards up to 64 KiB only when the complete UTF-8 MCP review fits the unchanged 160,000-byte budget; count both representations, escaping and operations, without truncation.
- Reject invalid paths, oversized or redacted reviews; serialize competing dashboard writes within one bridge instance.
- Make non-atomic whole-dashboard saving explicit. No automatic write retry or rollback.
- Retain REST, WebSocket, Keychain, isolated instances and on-demand operation.

## 0.1.0

Initial on-demand REST/WebSocket bridge. Preserved as GitHub Release v0.1.0 before the 0.2.0 update.
