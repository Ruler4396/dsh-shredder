# dsh-shredder

One red **Shred session** row inside DeepSeek Harness's own session menu, for permanently deleting a session you have already archived.

`dsh-shredder` is a community plugin for [DeepSeek Harness](https://www.deepseek.com/) (`dsh`). It is not an official DeepSeek AI product.

## What it does

- Adds one row to the **native** "…" menu of a session row, right below **Unarchive session**.
- The row only appears when that session **is archived** — an ordinary session never shows a delete option here.
- Two-step inline confirmation: the first click turns the row into **Confirm permanent delete**, the second one deletes. Closing the menu resets it.
- On success the session is gone from every surface: the workspace list, the ungrouped list and the archive set.
- If the log file is already gone but the id is still stuck in the archive set (a stale archive record), the same row just clears the record instead — and says so.

## What it deliberately does not do

- **No archive panel, no extra page, no sidebar entry.** Archived sessions are shown by dsh itself inside the workspace they belong to; the native **View options → hide / show / only archived** filter already lists them. This plugin adds the one action that dsh does not provide, in the place where the action belongs.
- **No bulk delete, no search, no preview, no restore-and-open.** If you want an archive *workspace*, see the alternatives below.
- **No trash can, no undo.** "Shred" here means the session directory is unlinked from the filesystem; it does not overwrite disk blocks. Recovering a shredded session needs a file-recovery tool at best.

## Requirements

- dsh **0.2.0-rc.2** verified. Older hosts are supported through a fallback path (they lack the public `unarchiveSession`), but only the current release is measured.
- A profile that loads bundles (the shipped `desktop` / `web` profiles).

## Install

1. Clone this repository somewhere stable, e.g. `C:\plugins\dsh-shredder`.
2. In your profile manifest `~/.dsh/profiles/<profile>/package.json`, add both entries:

   ```jsonc
   {
     "dependencies": { "dsh-shredder": "file:C:/plugins/dsh-shredder" },
     "dsh": { "profile": { "bundles": [ /* …existing bundles…, */ "dsh-shredder" ] } }
   }
   ```

3. Install with the pnpm that ships with dsh, then restart dsh (bundle composition is resolved at start; a page reload is not enough):

   ```powershell
   & "<dsh install>\resources\runtime\pnpm\bin\pnpm.cjs" --dir "$HOME\.dsh\profiles\<profile>" add "file:C:/plugins/dsh-shredder"
   ```

   On the desktop app the profile is `desktop`. `dsh --profile desktop --dump-config` is refused there (`profile "desktop" is managed exclusively by the Electron application`), so verify by restarting and opening a session menu.

4. Open the "…" menu of an archived session → **彻底删除 / Shred session** → click twice.

### Updating after you edit the source

`file:` dependencies are installed as a **copy**, not a link. Deleting the installed copy and running `pnpm install` (even with `--force`) does **not** re-copy it — pnpm answers `Already up to date` and the plugin silently stops being mounted. Re-declare the dependency instead, and check bytes:

```powershell
Remove-Item "$HOME\.dsh\profiles\<profile>\node_modules\dsh-shredder" -Recurse -Force
& "<pnpm.cjs>" --dir "$HOME\.dsh\profiles\<profile>" add "file:C:/plugins/dsh-shredder"   # must print `Packages: +1`
```

Then compare `lib/*.js` between the two trees (sha256), and restart.

### Uninstall

Remove the `dependencies` entry and the `dsh.profile.bundles` entry, run install again, restart. To stop mounting it without uninstalling, remove only the `bundles` entry — the bundle layer then never composes. Do **not** add a user-level `- id: shredder / disabled: true` line for that: an id that is not in the tree only makes every start print `patch: entry "shredder" not found` to stderr.

## How it works

| Half | File | Role |
| --- | --- | --- |
| Host | `lib/index.js` | one loopback HTTP endpoint |
| Client | `lib/client.js` | the menu row, injected into `sidebar.workspaces.session.menu.item` at `order: 450` |
| Mount | `cordis.patch.yml` | bundle-layer `insert` row (`id: shredder`) |

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/dsh-shredder/delete` | `{ sessionId }` | `{ ok, action: 'deleted' \| 'record-only', … }` |

Deletion order is part of correctness:

1. Ask the owners to stop — the official `workspace/session-stop` seam (agent turn, jobs, subagents, schedule).
2. `flush` the live session so buffered events reach disk.
3. Evict the resident instance from the session store, so every tab drops its row and no late write can rebuild the directory.
4. `WorkspaceEntity.detachSession` — drop the workspace membership slot. Archiving keeps the slot on purpose (unarchive restores the position), so deleting the file first would make the session flash back into the workspace list.
5. Remove `<session root>/<project>/<id>/`.
6. Unarchive (official `workspaceRegistry.unarchiveSession`), which clears the archive record.
7. Background re-checks at +2s / +6s / +15s delete a directory that a late flush resurrected.

## Known boundaries

- **Irreversible.** Export anything you might want back before shredding.
- **What stays behind.** Shredding removes the session log directory. The projection-cache entry under `storages/session_projcache/sessions/` and any content-addressed upload under `attachments/` are owned by dsh itself and are not removed here — measured on this machine: after a session directory is gone, the only file still carrying its id is the projection-cache entry.
- **Eviction touches runtime internals.** The session store has no public close/evict API, so step 3 reads `store.store` / `entry.detach` behind a presence probe; if a future host changes that shape the step reports `unsupported` instead of crashing.
- **Pinned sessions.** dsh makes pinning and archiving mutually exclusive, so a session reachable through this row cannot hold a pin.
- **Styling is a faithful copy, not an import.** The row mirrors the official `MenuItemButton` markup (`div.itemWrap > button[role=menuitem].item.danger` + `.itemIcon` + `.itemLabel`) and its design tokens, because `dsh-client-ui-primitives` is a build-time dependency and is not in the client module table for a plugin to `require`. If the host restyles its menus, this row needs the same edit.
- **Seat contract.** `sidebar.workspaces.session.menu.item` gives its children `{ sessionId, displayTitle }` plus the standard `useWorkspaces` snapshot hook (that is where the archive set comes from) and the injected `useMenuOpenState`. Native rows sit at orders 100/200/300/400.

## Alternatives, if you want more than one row

The plugin store has fuller archive managers — `@michengai/dsh-archive-manager` (a whole Settings page: title and content search, favorites, bulk restore, batch cleanup, log diagnosis), `dsh-better-archive` (settings section plus a right-sidebar archive tab, built on the host's own `Menu` / `RiskConfirmation`), and `dsh-archive-manager` (sidebar footer panel with agent teardown). They overlap with what this plugin does and go far beyond it. Pick this one only if what you wanted was "the delete option, in the menu, without another page".

## Development

```bash
node test/delete-endpoint.mjs     # host endpoint: response shapes, ghost records, negative control (deletes real temp dirs)
node test/style-injection.mjs     # client style-injection contract, four host-materialization scenarios
npm test                          # both
```

## License

MIT — see [LICENSE](LICENSE).
