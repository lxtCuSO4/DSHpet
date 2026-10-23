# Desktop Pet Manager Implementation Plan

> **For agentic workers:** Execute this approved plan inline using superpowers:executing-plans; use superpowers:requesting-code-review for the final independent review.

**Goal:** Provide a persistent manager for all pets and automatically yield to fullscreen content on Windows.

**Architecture:** Keep the desktop feature in focused CommonJS modules under runtime/electron-helper, with a trusted configuration store, pure visibility policy, Windows probe, and Electron controller. Reuse hostRequest for authoritative merged reads and asset previews; patch only small integration points in existing main/preload/sprite files. Configuration writes are serialized, scoped by server-resolved entry/ID, validated and backed up; positions/preferences are separate local state.

**Tech Stack:** Existing Electron, Node built-in test runner, plain HTML/CSS/JavaScript, Windows PowerShell 5.1 with Win32 P/Invoke, Playwright for browser verification.

### Task 1: Configuration and visibility rules

- [x] Add `scripts/tests/desktop-manager.test.mjs` using real temporary directories. Assert preserving unknown properties, desktop/web bit toggling, rejected unknown fields/ranges/duplicate identities, malformed config refusal, local backup, and position persistence.
- [x] Run `node --test scripts/tests/desktop-manager.test.mjs`; verify feature tests fail before implementation.
- [x] Create `runtime/electron-helper/manager-store.js` with JSONC parsing, scoped atomic writes and preference persistence; create `manager-policy.js` with display toggle, visible-state and physical rectangle rules.
- [x] Repeat the tests until all pass; test smart mode excludes manual-off pets during restoration and limits suppression to intersecting fullscreen monitor.

### Task 2: Windows full screen observer

- [x] Extend policy tests for normal maximized dimensions, fullscreen tolerance, shell exclusion, multiple monitors and probe failure state.
- [x] Create `fullscreen-probe.ps1` with asynchronous native foreground/top-level rectangle observation, no titles/credentials, polling at 300 ms and EOF/parent exit cleanup. Create `fullscreen-observer.js` to parse bounded JSON lines and expose start/stop/status without blocking Electron.
- [x] Run unit tests and PowerShell AST parsing; run a real probe process and verify clean stop.

### Task 3: Management window and runtime control

- [x] Add integration tests for all-off then re-enable, shifted pet indexes, temporary hide separate from persistent switches, controller error propagation and manager-only IPC authorization.
- [x] Create `manager-controller.js` (window, IPC, polling, preference/position lifecycle, visibility, hotkey and tray callbacks) and `manager-preload.js` (only get/update/recover/preferences/hide/open operations).
- [x] Add `manager.html`, `manager.css`, `manager-page.js` with status, previews, independent toggles, size/reset, recover, modes and optional hotkey.
- [x] Add minimal main hooks for createPetWindows(pets), retain changed window creation signatures, register manager controller after bridge readiness, and add tray open/hide entries. Add right-click settings action via existing preload.
- [x] Verify browser interactions with representative fixture configuration, keyboard use, save failures and narrow widths. Save screenshots only under ignored `_art`.

### Task 4: Deployment, review and delivery

- [x] Add `pet-pack/deploy-desktop-manager.mjs` with explicit source/target directories, exact single integration marker replacement, backup, hash checks and repeat-safe behavior; never copy entire installed main/sprite/preload/index.
- [x] Validate installed helper in an isolated copy and user-data directory; cover real fullscreen and maximized window behavior, tray reopen after all-off, sizes and remembered positions. Stop helper/probe and remove temporary hooks.
- [x] Apply backed-up controlled patch to the user's installed package, then request existing host reload once, preserving latest positions and confirming both named pets and original素材/CSS hashes.
- [x] Run focused Node tests, UI tests and syntax checks; request independent code review, fix concrete defects and rerun affected tests.
- [x] Update `AGENTS.md`, README/use guide and this checklist with actual verification results. Review staged scope/secrets, commit, fast-forward main, push origin, verify remote SHA, then delete the temporary branch and archive the managed worktree.
