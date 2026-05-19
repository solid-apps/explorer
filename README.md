# explorer

A focused file explorer for Solid pods. Browse containers, read resources, see what's there — like Finder / Nautilus / Windows Explorer, but for the web of pods. Login via [xlogin](https://npm.im/xlogin).

## Install

```bash
jss install explorer
```

Open `http://<your-pod>/public/apps/explorer/`.

## Phases

- [x] **1. Scaffold** — Lichess-cream UI; URL bar; breadcrumb; container listing (sorted, containers first); JSON-LD-aware preview pane (URIs render as clickable links); image/audio/video previews; tabular numerals; subtle hover/selection; back & up navigation.
- [ ] **2. Operations** — Create container / resource, rename, delete, move (drag or cut-paste). Trash bin at `/private/.trash/` for soft delete.
- [ ] **3. Preview pane fidelity** — Markdown rendered; PDF embedded; metadata sidebar (size / modified / content-type / ACL summary).
- [ ] **4. ACL editor** — Inline view of who can do what on the selected resource; edit via MCP `read_acl` / `write_acl` or direct `.acl` PUT.
- [ ] **5. Subscribe + multi-user** — WebSocket subscribe to the current container; live updates when others write. "Alice is here" presence.
- [ ] **6. Upload + drag-drop** — Drop files from desktop into a container.
- [ ] **7. Cross-pod browse** — URL bar accepts any pod; switch between pods you have access to; "Recent pods" sidebar.
- [ ] **8. Search + bulk** — Find by name across containers; multi-select for bulk delete / move / ACL change.

## What this isn't

- Not a workspace shell — that's [hub](https://github.com/solid-apps/hub).
- Not a data inspector with a rich graph UI — that's mashlib.
- Not retro nostalgia — that's [win98](https://github.com/solid-apps/win98).

Just a file explorer for pods. Boring, expected, world-class. (We hope.)

## License

[AGPL-3.0-or-later](./LICENSE)
