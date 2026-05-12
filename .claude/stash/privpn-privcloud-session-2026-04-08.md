# privpn + privcloud Session Stash (Continued)
**Date:** 2026-04-06 to 2026-04-08
**Continues from:** privpn-privcloud-session-2026-04-06.md

## What was accomplished (since last stash)

### privpn
- Save to pass now stores everything: VPS config, SSH keys, all WireGuard configs fetched from VPS
- Updated customer guide with full pass tree and restore commands
- Updated CHANGELOG

### privcloud
- **Save to pass (option 15):** Runs from laptop via SSH, fetches all server data in one call
- **Manage storage (option 12):** Replaced "Mount USB" with sub-menu:
  1. Status — drives, mounts, paths, disk usage (separates USB from internal via TRAN column)
  2. Mount USB — auto-detects USB drives
  3. Unmount USB — safely unmount + remove from fstab
  4. Change media location — updates Jellyfin, redeploys
  5. Change data location — updates Immich paths, redeploys
- **FileBrowser fix:** Now mounts FILES_LOCATION (base data path) showing media/, files/, immich/
- **Jellyfin fix:** Mounts MEDIA_LOCATION only, dropped :ro flag
- **FileBrowser password:** Auto-set to 'privcloud' during deploy (no more random passwords)
- **DATA_ROOT removed**, replaced with FILES_LOCATION
- **Status display:** Separated media from Immich paths
- **Customer guide:** Added troubleshooting for broken privcloud/federver commands, removed hardcoded usernames
- Fixed privcloud command wrapper on server (was pointing to wrong path)
- All docs updated: README, customer-guide, CHANGELOG

### VPS (104.129.2.254)
- Flushed leftover podman CNI iptables rules
- Clean masquerade for WireGuard working
- privpn connect working with dedicated 'privpn' interface

### Friction analysis
- Ran friction on 6 sessions, 83% BAD rate
- Top signals: false_success (claiming things work when they don't), user_negation, tool_loop
- Created MEMORY.md with facts, episodes, preferences
- Key preference: "existing working code is the specification" (privcloud pattern)

### Interview prep template
- Created interview-prep-template.md — generic template with AI prompt (20 multi-turn questions)
- Phase 2: Output preferences (AI asks before generating)
- Phase 3: Two outputs (md + html)
- 2 sample fictional stories
- Generated HTML versions of both template and original prep doc

### Research discussions
- **mempalace (milla-jovovich/mempalace):** Analyzed AAAK compression format (30x, semantic-preserving dialect). Borrowable for aurora: entity codes, layered loading, flag vocabulary. Not the palace hierarchy or emotion codes.
- **Friction as the real product:** Concluded slash commands (/friction, /stash, /remember) are the universal interface. No cron, no hooks, no auto-injection. Claude's built-in memory will handle storage; friction handles behavioral pattern extraction.
- **MCPorter (steipete/mcporter):** MCP convenience toolkit, not a competitor. The interesting idea: a thin mcp-bridge for bareagent (~200-300 lines) that discovers existing MCP servers and lets bareagent orchestrate them. Would make bareagent a universal orchestrator for the entire MCP ecosystem.

### Hardware
- Orico 2.5" enclosure doesn't close — Seagate GoFlex drive is 15.5mm thick (standard is 7-9.5mm)
- GoFlex didn't need power adapter because it's 2.5" (USB bus-powered), not 3.5"
- Recommended: ICY BOX IB-256WP (€19, supports up to 15mm) on Amazon.nl

## Key decisions
- FILES_LOCATION = base data path (FileBrowser root), MEDIA_LOCATION = media only (Jellyfin)
- FileBrowser shows everything (media, files, immich) — user decided to keep immich visible
- FileBrowser password auto-set to 'privcloud' during deploy
- Friction stays as slash commands, not automated/hooked
- mcp-bridge for bareagent is worth building (thin layer, 200-300 lines, discovers existing MCP configs)

## Pending
- Test manage storage (option 12) on home server
- Jellyfin library setup: user needs to add library pointing to /media
- ICY BOX IB-256WP purchase for the thick HDD
- BIOS auto-power-on setting on home server
- mcp-bridge design for bareagent (future)
