# palworld-docker-wine

Run the **Windows** Palworld dedicated server in Docker on Linux, under [Wine](https://www.winehq.org/).

## Why?

Palworld's official mod system (UE4SS, PalSchema, Lua, and the Steam Workshop
`Mods/` + `PalModSettings.ini` flow — see the
[official docs](https://docs.palworldgame.com/settings-and-operation/mod)) is
**Windows-server-only**. The excellent native-Linux images (like
[thijsvanloef/palworld-server-docker](https://github.com/thijsvanloef/palworld-server-docker))
can only sideload pak-format mods. This image runs the Windows server build under
Wine so the full mod system works on a Linux Docker host.

Wine is a compatibility layer, not an emulator — the server runs the same x86-64
instructions at near-native speed; Windows API calls are translated to Linux syscalls.

## Quick start

```bash
git clone <this repo> && cd palworld-docker-wine
# edit docker-compose.yml: set SERVER_PASSWORD, ADMIN_PASSWORD and MANAGER_PASSWORD
docker compose up -d --build
docker logs -f palworld-wine     # first boot downloads ~6 GB via steamcmd
```

The game listens on `8211/udp`, the REST API on `8212/tcp` (basic auth: `admin` /
`ADMIN_PASSWORD`). First boot takes a few minutes (Steam download + Wine prefix +
vcrun2022 install + world generation); subsequent boots are ~30 seconds.

## Bundled web manager

`docker compose up` also starts a **server manager UI** on
[http://localhost:8220](http://localhost:8220) (basic auth, any username,
password = `MANAGER_PASSWORD` from the compose file):

- live dashboard (players, FPS, uptime) via the game's REST API
- full settings editor (all `PalWorldSettings.ini` values, min/max validated)
  writing to this compose file's environment, with config-drift detection
- announcements with canned messages; deploy pipeline with countdown
  announcements, world save, recreate, and post-restart validation
- backups (list/create/download) and **world save export / import / migrate**
  (optionally assigning a fresh world GUID and stripping `WorldOption.sav`)
- Steam Workshop mod browser with Linux/Windows type filtering and installs

Don't want it? `docker compose up -d palworld-wine` starts just the game server.

## How it works

- Native Linux **steamcmd** downloads the *Windows* depot using
  `@sSteamCmdForcePlatformType windows` (app `2394010`) — no Wine involved in the download.
- The server runs under Wine with a virtual framebuffer (`xvfb`).
- `PalWorldSettings.ini` is generated from environment variables on each boot,
  using the same variable names as thijsvanloef/palworld-server-docker
  (template derived from that project — credit to its authors), so tooling
  built for that image works with this one. Set `DISABLE_GENERATE_SETTINGS=true`
  to manage the INI by hand.
- The official mod directory is created at
  `Pal/Binaries/Win64/Mods/` (symlinked at `/palworld/Mods`) with
  `bGlobalEnableMod=true`. Drop Workshop mods into `Mods/Workshop/<name>/` and
  list their `Info.json` PackageNames via `ActiveModList=` in `PalModSettings.ini`,
  then restart.

## Hard-won Wine specifics (the reasons this image looks the way it does)

Several of these were learned the hard way, then confirmed against the working
setup in [ripps818/docker-palworld-dedicated-server-wine](https://github.com/ripps818/docker-palworld-dedicated-server-wine)
(credit where due):

1. **Launch `PalServer-Win64-Shipping-Cmd.exe`** — the console build. The
   `PalServer.exe` launcher stub hangs under Wine without ever starting the
   server, and the windowed `PalServer-Win64-Shipping.exe` misbehaves
   (save failures, broken logins).
2. **`winetricks vcrun2022` is essential.** Wine's built-in C runtime is
   incomplete; without the real Visual C++ 2022 runtime, Palworld's atomic
   save pipeline fails (`Failed to save. Failed copy from backup.`, players
   kicked at character creation, eventual crash).
3. **WineHQ stable** (with recommends) rather than the distro's minimal wine.
4. Multithread flags help dedicated servers:
   `-useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS`.
5. `winbind` is needed for Steam's NTLM auth (`ntlm_auth`).
6. The Steam net library logs
   `Assertion Failed: CalcUnIPThisBox - GetAdaptersAddresses returned 13` at
   boot — harmless in practice.

## Environment variables

All world-setting variables from
[thijsvanloef/palworld-server-docker's table](https://github.com/thijsvanloef/palworld-server-docker#environment-variables)
that map to `PalWorldSettings.ini` are supported (same names, e.g. `EXP_RATE`,
`DEATH_PENALTY`, `PLAYERS`). Image-infrastructure features of that project
(auto-update/reboot cron, Discord webhooks, etc.) are **not** implemented here —
this image is deliberately minimal. Notable extras:

| Variable | Default | Purpose |
|---|---|---|
| `UPDATE_ON_BOOT` | `false` | steamcmd update/validate on every start |
| `DISABLE_GENERATE_SETTINGS` | unset | `true` = never touch `PalWorldSettings.ini` |
| `USE_BACKUP_SAVE_DATA` | `False` | keep `False` under Wine (see above) |

## Save compatibility

Windows and Linux server builds share the same save format. Worlds
(`Pal/Saved/SaveGames/0/<GUID>/`) can be copied in either direction; point
`DedicatedServerName` in `GameUserSettings.ini` at the GUID and restart.

## Status

⚠️ **Experimental.** The server boots, accepts players, and initializes the
official mod system (it writes its own `PalModSettings.ini` `ConfigVersion`
header on first run). Long-run stability under Wine and behaviour of individual
mods are yours to discover — this is a test-bench image, not a hardened
production one. Issues and PRs welcome.

## Credits

- [thijsvanloef/palworld-server-docker](https://github.com/thijsvanloef/palworld-server-docker)
  for the environment-variable convention and settings template this image reuses.
- [ripps818/docker-palworld-dedicated-server-wine](https://github.com/ripps818/docker-palworld-dedicated-server-wine)
  for proving the working Wine recipe (vcrun2022, console binary, WineHQ stable)
  that this image's Wine specifics are aligned with — if you want a
  fuller-featured Wine image (webhooks, cron, backups), use theirs.
- The Wine, winetricks and steamcmd projects.
