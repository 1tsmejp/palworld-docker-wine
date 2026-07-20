#!/bin/bash
# EXPERIMENTAL Palworld Windows-server-under-Wine entrypoint.
# Env→PalWorldSettings.ini uses the same variable names as
# thijsvanloef/palworld-server-docker so the manager can drive both kinds
# of server identically (template dumped from that image).
set -e

log() { echo "[wine-test] $*"; }

# ---------------------------------------------------------------- discord webhooks
# Same env contract as thijsvanloef/palworld-server-docker (subset):
# DISCORD_WEBHOOK_URL + DISCORD_<EVENT>_MESSAGE / _MESSAGE_ENABLED / _MESSAGE_URL
# for PRE_UPDATE_BOOT, POST_UPDATE_BOOT, PRE_START, PRE_SHUTDOWN, POST_SHUTDOWN,
# PLAYER_JOIN, PLAYER_LEAVE. player_name is substituted in join/leave messages.
discord_send() { # $1 = event key, $2 = default message, $3 = player name (optional)
  local ev="$1" def="$2" sub="${3:-}"
  local url_var="DISCORD_${ev}_MESSAGE_URL" en_var="DISCORD_${ev}_MESSAGE_ENABLED" msg_var="DISCORD_${ev}_MESSAGE"
  local url="${!url_var}"; [ -z "$url" ] && url="${DISCORD_WEBHOOK_URL:-}"
  [ -z "$url" ] && return 0
  local enabled="${!en_var:-true}"
  [ "${enabled,,}" = "true" ] || return 0
  local msg="${!msg_var:-$def}"
  [ -n "$sub" ] && msg="${msg//player_name/$sub}"
  local flags=0
  [ "${DISCORD_SUPPRESS_NOTIFICATIONS,,}" = "true" ] && flags=4096
  curl -sf -m "${DISCORD_MAX_TIMEOUT:-30}" --connect-timeout "${DISCORD_CONNECT_TIMEOUT:-30}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg c "$msg" --argjson f "$flags" '{content: $c, flags: $f}')" \
    "$url" >/dev/null 2>&1 || log "discord: webhook failed for $ev"
}

STEAMCMD=/usr/games/steamcmd
SERVER_DIR=/palworld
# Raw admin password for REST API calls — captured BEFORE the env→ini section
# below re-exports string vars wrapped in literal quotes for the template
# (after that, $ADMIN_PASSWORD contains the quote characters).
REST_ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
WIN_CFG_DIR="$SERVER_DIR/Pal/Saved/Config/WindowsServer"
EXE_DIR="$SERVER_DIR/Pal/Binaries/Win64"

# ---------------------------------------------------------------- install/update
if [ ! -f "$SERVER_DIR/PalServer.exe" ] || [ "${UPDATE_ON_BOOT,,}" = "true" ]; then
  log "Installing/updating Palworld WINDOWS dedicated server (app 2394010)…"
  discord_send PRE_UPDATE_BOOT 'Server is updating...'
  $STEAMCMD +@sSteamCmdForcePlatformType windows \
    +force_install_dir "$SERVER_DIR" \
    +login anonymous \
    +app_update 2394010 validate \
    +quit
  log "Install/update done."
  discord_send POST_UPDATE_BOOT 'Server update complete!'
fi

# ---------------------------------------------------------------- settings (env -> ini)
# Defaults mirror the thijsvanloef image; any env var overrides.
export DIFFICULTY=${DIFFICULTY:-None} RANDOMIZER_TYPE=${RANDOMIZER_TYPE:-None}
export RANDOMIZER_SEED=\"${RANDOMIZER_SEED:-}\" IS_RANDOMIZER_PAL_LEVEL_RANDOM=${IS_RANDOMIZER_PAL_LEVEL_RANDOM:-False}
export DAYTIME_SPEEDRATE=${DAYTIME_SPEEDRATE:-1.0} NIGHTTIME_SPEEDRATE=${NIGHTTIME_SPEEDRATE:-1.0}
export EXP_RATE=${EXP_RATE:-1.0} PAL_CAPTURE_RATE=${PAL_CAPTURE_RATE:-1.0} PAL_SPAWN_NUM_RATE=${PAL_SPAWN_NUM_RATE:-1.0}
export PAL_DAMAGE_RATE_ATTACK=${PAL_DAMAGE_RATE_ATTACK:-1.0} PAL_DAMAGE_RATE_DEFENSE=${PAL_DAMAGE_RATE_DEFENSE:-1.0}
export PLAYER_DAMAGE_RATE_ATTACK=${PLAYER_DAMAGE_RATE_ATTACK:-1.0} PLAYER_DAMAGE_RATE_DEFENSE=${PLAYER_DAMAGE_RATE_DEFENSE:-1.0}
export PLAYER_STOMACH_DECREASE_RATE=${PLAYER_STOMACH_DECREASE_RATE:-1.0} PLAYER_STAMINA_DECREASE_RATE=${PLAYER_STAMINA_DECREASE_RATE:-1.0}
export PLAYER_AUTO_HP_REGEN_RATE=${PLAYER_AUTO_HP_REGEN_RATE:-1.0} PLAYER_AUTO_HP_REGEN_RATE_IN_SLEEP=${PLAYER_AUTO_HP_REGEN_RATE_IN_SLEEP:-1.0}
export PAL_STOMACH_DECREASE_RATE=${PAL_STOMACH_DECREASE_RATE:-1.0} PAL_STAMINA_DECREASE_RATE=${PAL_STAMINA_DECREASE_RATE:-1.0}
export PAL_AUTO_HP_REGEN_RATE=${PAL_AUTO_HP_REGEN_RATE:-1.0} PAL_AUTO_HP_REGEN_RATE_IN_SLEEP=${PAL_AUTO_HP_REGEN_RATE_IN_SLEEP:-1.0}
export BUILD_OBJECT_HP_RATE=${BUILD_OBJECT_HP_RATE:-1.0} BUILD_OBJECT_DAMAGE_RATE=${BUILD_OBJECT_DAMAGE_RATE:-1.0}
export BUILD_OBJECT_DETERIORATION_DAMAGE_RATE=${BUILD_OBJECT_DETERIORATION_DAMAGE_RATE:-1.0}
export COLLECTION_DROP_RATE=${COLLECTION_DROP_RATE:-1.0} COLLECTION_OBJECT_HP_RATE=${COLLECTION_OBJECT_HP_RATE:-1.0}
export COLLECTION_OBJECT_RESPAWN_SPEED_RATE=${COLLECTION_OBJECT_RESPAWN_SPEED_RATE:-1.0} ENEMY_DROP_ITEM_RATE=${ENEMY_DROP_ITEM_RATE:-1.0}
export DEATH_PENALTY=${DEATH_PENALTY:-Item}
export ENABLE_PLAYER_TO_PLAYER_DAMAGE=${ENABLE_PLAYER_TO_PLAYER_DAMAGE:-False} ENABLE_FRIENDLY_FIRE=${ENABLE_FRIENDLY_FIRE:-False}
export ENABLE_INVADER_ENEMY=${ENABLE_INVADER_ENEMY:-True} ACTIVE_UNKO=${ACTIVE_UNKO:-False}
export ENABLE_AIM_ASSIST_PAD=${ENABLE_AIM_ASSIST_PAD:-True} ENABLE_AIM_ASSIST_KEYBOARD=${ENABLE_AIM_ASSIST_KEYBOARD:-False}
export DROP_ITEM_MAX_NUM=${DROP_ITEM_MAX_NUM:-3000} DROP_ITEM_MAX_NUM_UNKO=${DROP_ITEM_MAX_NUM_UNKO:-100}
export BASE_CAMP_MAX_NUM=${BASE_CAMP_MAX_NUM:-128} BASE_CAMP_WORKER_MAX_NUM=${BASE_CAMP_WORKER_MAX_NUM:-15}
export DROP_ITEM_ALIVE_MAX_HOURS=${DROP_ITEM_ALIVE_MAX_HOURS:-1.0}
export AUTO_RESET_GUILD_NO_ONLINE_PLAYERS=${AUTO_RESET_GUILD_NO_ONLINE_PLAYERS:-False}
export AUTO_RESET_GUILD_TIME_NO_ONLINE_PLAYERS=${AUTO_RESET_GUILD_TIME_NO_ONLINE_PLAYERS:-72.0}
export GUILD_PLAYER_MAX_NUM=${GUILD_PLAYER_MAX_NUM:-20} BASE_CAMP_MAX_NUM_IN_GUILD=${BASE_CAMP_MAX_NUM_IN_GUILD:-4}
export PAL_EGG_DEFAULT_HATCHING_TIME=${PAL_EGG_DEFAULT_HATCHING_TIME:-1.0} WORK_SPEED_RATE=${WORK_SPEED_RATE:-1.0}
export AUTO_SAVE_SPAN=${AUTO_SAVE_SPAN:-30.0}
export IS_MULTIPLAY=${IS_MULTIPLAY:-False} IS_PVP=${IS_PVP:-False} HARDCORE=${HARDCORE:-False}
export CHARACTER_RECREATE_IN_HARDCORE=${CHARACTER_RECREATE_IN_HARDCORE:-False} PAL_LOST=${PAL_LOST:-False}
export CAN_PICKUP_OTHER_GUILD_DEATH_PENALTY_DROP=${CAN_PICKUP_OTHER_GUILD_DEATH_PENALTY_DROP:-False}
export ENABLE_NON_LOGIN_PENALTY=${ENABLE_NON_LOGIN_PENALTY:-True} ENABLE_FAST_TRAVEL=${ENABLE_FAST_TRAVEL:-True}
export IS_START_LOCATION_SELECT_BY_MAP=${IS_START_LOCATION_SELECT_BY_MAP:-False}
export EXIST_PLAYER_AFTER_LOGOUT=${EXIST_PLAYER_AFTER_LOGOUT:-False} ENABLE_DEFENSE_OTHER_GUILD_PLAYER=${ENABLE_DEFENSE_OTHER_GUILD_PLAYER:-False}
export INVISIBLE_OTHER_GUILD_BASE_CAMP_AREA_FX=${INVISIBLE_OTHER_GUILD_BASE_CAMP_AREA_FX:-False} BUILD_AREA_LIMIT=${BUILD_AREA_LIMIT:-False}
export ITEM_WEIGHT_RATE=${ITEM_WEIGHT_RATE:-1.0} COOP_PLAYER_MAX_NUM=${COOP_PLAYER_MAX_NUM:-4}
export SERVER_PLAYER_MAX_NUM=${PLAYERS:-32}
export SERVER_NAME=\"${SERVER_NAME:-Palworld Wine Test}\" SERVER_DESCRIPTION=\"${SERVER_DESCRIPTION:-}\"
export ADMIN_PASSWORD=\"${ADMIN_PASSWORD:-}\" SERVER_PASSWORD=\"${SERVER_PASSWORD:-}\"
export PUBLIC_PORT=${PUBLIC_PORT:-8211} PUBLIC_IP=\"${PUBLIC_IP:-}\"
export RCON_ENABLED=${RCON_ENABLED:-False} RCON_PORT=${RCON_PORT:-25575}
export REGION=\"${REGION:-}\" USEAUTH=${USEAUTH:-True}
export BAN_LIST_URL=\"${BAN_LIST_URL:-https://b.palworldgame.com/api/banlist.txt}\"
export REST_API_ENABLED=${REST_API_ENABLED:-True} REST_API_PORT=${REST_API_PORT:-8212}
export SHOW_PLAYER_LIST=${SHOW_PLAYER_LIST:-False} CHAT_POST_LIMIT_PER_MINUTE=${CHAT_POST_LIMIT_PER_MINUTE:-30}
export USE_BACKUP_SAVE_DATA=${USE_BACKUP_SAVE_DATA:-True} SUPPLY_DROP_SPAN=${SUPPLY_DROP_SPAN:-180}
export ENABLE_PREDATOR_BOSS_PAL=${ENABLE_PREDATOR_BOSS_PAL:-True} MAX_BUILDING_LIMIT_NUM=${MAX_BUILDING_LIMIT_NUM:-0}
export SERVER_REPLICATE_PAWN_CULL_DISTANCE=${SERVER_REPLICATE_PAWN_CULL_DISTANCE:-15000.0}
export CROSSPLAY_PLATFORMS=${CROSSPLAY_PLATFORMS:-"(Steam,Xbox,PS5,Mac)"}
export ALLOW_GLOBAL_PALBOX_EXPORT=${ALLOW_GLOBAL_PALBOX_EXPORT:-True} ALLOW_GLOBAL_PALBOX_IMPORT=${ALLOW_GLOBAL_PALBOX_IMPORT:-False}
export EQUIPMENT_DURABILITY_DAMAGE_RATE=${EQUIPMENT_DURABILITY_DAMAGE_RATE:-1.0}
export ITEM_CONTAINER_FORCE_MARK_DIRTY_INTERVAL=${ITEM_CONTAINER_FORCE_MARK_DIRTY_INTERVAL:-1.0}
export ITEM_CORRUPTION_MULTIPLIER=${ITEM_CORRUPTION_MULTIPLIER:-1.0} PHYSICS_ACTIVE_DROP_ITEM_MAX_NUM=${PHYSICS_ACTIVE_DROP_ITEM_MAX_NUM:--1}
export ALLOW_CLIENT_MOD=${ALLOW_CLIENT_MOD:-True} PLAYER_DATA_PAL_STORAGE_UPDATE_CHECK_TICK_INTERVAL=${PLAYER_DATA_PAL_STORAGE_UPDATE_CHECK_TICK_INTERVAL:-1.0}
export LOG_FORMAT_TYPE=${LOG_FORMAT_TYPE:-Text} IS_SHOW_JOIN_LEFT_MESSAGE=${IS_SHOW_JOIN_LEFT_MESSAGE:-True}
export MONSTER_FARM_ACTION_SPEED_RATE=${MONSTER_FARM_ACTION_SPEED_RATE:-1.0} DENY_TECHNOLOGY_LIST="${DENY_TECHNOLOGY_LIST:-}"
export GUILD_REJOIN_COOLDOWN_MINUTES=${GUILD_REJOIN_COOLDOWN_MINUTES:-0}
export AUTO_TRANSFER_MASTER_CHECK_INTERVAL_SECONDS=${AUTO_TRANSFER_MASTER_CHECK_INTERVAL_SECONDS:-3600.0}
export AUTO_TRANSFER_MASTER_THRESHOLD_DAYS=${AUTO_TRANSFER_MASTER_THRESHOLD_DAYS:-14} MAX_GUILDS_PER_FRAME=${MAX_GUILDS_PER_FRAME:-10}
export BLOCK_RESPAWN_TIME=${BLOCK_RESPAWN_TIME:-5.0} RESPAWN_PENALTY_DURATION_THRESHOLD=${RESPAWN_PENALTY_DURATION_THRESHOLD:-0.0}
export RESPAWN_PENALTY_TIME_SCALE=${RESPAWN_PENALTY_TIME_SCALE:-2.0}
export DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_BASE_CAMP=${DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_BASE_CAMP:-False}
export DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_PLAYER=${DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_PLAYER:-False}
export ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE="${ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE:-PlayerDropItem}"
export ADDITIONAL_DROP_ITEM_NUM_WHEN_PLAYER_KILLING_IN_PVP_MODE=${ADDITIONAL_DROP_ITEM_NUM_WHEN_PLAYER_KILLING_IN_PVP_MODE:-1}
export ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE_ENABLED=${ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE_ENABLED:-False}
export ENABLE_VOICE_CHAT=${ENABLE_VOICE_CHAT:-False}
export VOICE_CHAT_MAX_VOLUME_DISTANCE=${VOICE_CHAT_MAX_VOLUME_DISTANCE:-3000.0} VOICE_CHAT_ZERO_VOLUME_DISTANCE=${VOICE_CHAT_ZERO_VOLUME_DISTANCE:-15000.0}
export ALLOW_ENHANCE_STAT_HEALTH=${ALLOW_ENHANCE_STAT_HEALTH:-True} ALLOW_ENHANCE_STAT_ATTACK=${ALLOW_ENHANCE_STAT_ATTACK:-True}
export ALLOW_ENHANCE_STAT_STAMINA=${ALLOW_ENHANCE_STAT_STAMINA:-True} ALLOW_ENHANCE_STAT_WEIGHT=${ALLOW_ENHANCE_STAT_WEIGHT:-True}
export ALLOW_ENHANCE_STAT_WORK_SPEED=${ALLOW_ENHANCE_STAT_WORK_SPEED:-True}
export ENABLE_BUILDING_PLAYER_UID_DISPLAY=${ENABLE_BUILDING_PLAYER_UID_DISPLAY:-False}
export BUILDING_NAME_DISPLAY_CACHE_TTL_SECONDS=${BUILDING_NAME_DISPLAY_CACHE_TTL_SECONDS:-60}

if [ "${DISABLE_GENERATE_SETTINGS,,}" != "true" ]; then
  log "Generating PalWorldSettings.ini from environment…"
  mkdir -p "$WIN_CFG_DIR"
  {
    echo "[/Script/Pal.PalGameWorldSettings]"
    envsubst < /home/steam/PalWorldSettings.ini.template | tr -d '\n\r'
    echo
  } > "$WIN_CFG_DIR/PalWorldSettings.ini"
fi

# ---------------------------------------------------------------- official mod system
# docs.palworldgame.com/settings-and-operation/mod — Windows servers load mods
# from Mods/ next to the executable, enabled via Mods/PalModSettings.ini.
mkdir -p "$EXE_DIR/Mods/Workshop"
if [ ! -f "$EXE_DIR/Mods/PalModSettings.ini" ]; then
  {
    echo "bGlobalEnableMod=true"
    # Add one line per mod PackageName (from its Info.json):
    # ActiveModList=SomePackageName
  } > "$EXE_DIR/Mods/PalModSettings.ini"
  log "Created default Mods/PalModSettings.ini (bGlobalEnableMod=true)"
fi
ln -sfn "$EXE_DIR/Mods" "$SERVER_DIR/Mods" || true

# ---------------------------------------------------------------- env-driven mods
# WORKSHOP_MODS: comma-separated Steam Workshop IDs installed at boot if
# missing (declarative, ripps818-style). Requires a Steam auth token stored
# by a prior sign-in (persisted at /palworld/.depotdownloader).
if [ -n "${WORKSHOP_MODS:-}" ]; then
  if [ -d /palworld/.depotdownloader/IsolatedStorage ]; then
    mkdir -p "$HOME/.local/share"
    rm -rf "$HOME/.local/share/IsolatedStorage"
    cp -r /palworld/.depotdownloader/IsolatedStorage "$HOME/.local/share/"
  fi
  ACCT_FILE=$(find "$HOME/.local/share/IsolatedStorage" -name account.config 2>/dev/null | head -1 || true)
  SUSER=""
  if [ -n "$ACCT_FILE" ]; then
    SUSER=$(sed -n 's/.*"LoginTokens"[^{]*{[^"]*"\([^"]*\)".*/\1/p' "$ACCT_FILE" | head -1)
  fi
  for MODID in $(echo "$WORKSHOP_MODS" | tr ',' ' '); do
    if [ -d "$EXE_DIR/Mods/Workshop/$MODID" ] || [ -d "$SERVER_DIR/Pal/Content/Paks/~mods/$MODID" ]; then
      continue
    fi
    if [ -z "$SUSER" ]; then
      log "WORKSHOP_MODS: no stored Steam token — cannot install $MODID (sign in via the manager once)"
      continue
    fi
    log "WORKSHOP_MODS: installing $MODID…"
    TMPD="/tmp/wsmod-$MODID"
    rm -rf "$TMPD"
    if DepotDownloader -app 1623730 -pubfile "$MODID" -username "$SUSER" -remember-password -dir "$TMPD" >/dev/null 2>&1; then
      INFO=$(find "$TMPD" -maxdepth 4 -name Info.json 2>/dev/null | head -1 || true)
      if [ -n "$INFO" ]; then
        DEST="$EXE_DIR/Mods/Workshop/$MODID"
        mkdir -p "$DEST" && cp -r "$(dirname "$INFO")/." "$DEST/"
        PKG=$(sed -n 's/.*"PackageName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INFO" | head -1)
        INIF="$EXE_DIR/Mods/PalModSettings.ini"
        touch "$INIF"
        if ! grep -q "bGlobalEnableMod=" "$INIF"; then echo "bGlobalEnableMod=True" >> "$INIF"; fi
        if [ -n "$PKG" ] && ! grep -q "ActiveModList=$PKG" "$INIF"; then echo "ActiveModList=$PKG" >> "$INIF"; fi
        log "WORKSHOP_MODS: installed official mod $MODID (${PKG:-no PackageName})"
      else
        DEST="$SERVER_DIR/Pal/Content/Paks/~mods/$MODID"
        mkdir -p "$DEST"
        find "$TMPD" -type f \( -name '*.pak' -o -name '*.utoc' -o -name '*.ucas' \) -exec mv {} "$DEST/" \;
        log "WORKSHOP_MODS: installed pak mod $MODID"
      fi
    else
      log "WORKSHOP_MODS: download failed for $MODID (token expired? re-sign-in via manager)"
    fi
    rm -rf "$TMPD"
  done
  # persist any refreshed tokens
  if [ -d "$HOME/.local/share/IsolatedStorage" ]; then
    mkdir -p /palworld/.depotdownloader
    rm -rf /palworld/.depotdownloader/IsolatedStorage
    cp -r "$HOME/.local/share/IsolatedStorage" /palworld/.depotdownloader/
  fi
fi

# ---------------------------------------------------------------- run under wine
cleanup() {
  log "SIGTERM — stopping wine…"
  discord_send PRE_SHUTDOWN 'Server is shutting down...'
  [ -n "${MONITOR_PID:-}" ] && kill "$MONITOR_PID" 2>/dev/null
  # a paused (SIGSTOPped) game can't handle shutdown — resume it first
  pkill -CONT -f 'PalServer-Win64-Shipping-Cmd.exe' 2>/dev/null || true
  wineserver -k || true
  wait
  discord_send POST_SHUTDOWN 'Server is stopped!'
  exit 0
}
trap cleanup SIGTERM SIGINT

# ---------------------------------------------------------------- monitor: discord join/leave + auto pause
# Polls the REST API for the player list. Feeds two features:
#  - Discord PLAYER_JOIN / PLAYER_LEAVE messages (diff between polls)
#  - AUTO_PAUSE_ENABLED: saves the world ~30s after the server empties, then
#    SIGSTOPs the game process after AUTO_PAUSE_TIMEOUT_EST seconds (world
#    time and CPU stop). Any UDP packet on the game port resumes it — a
#    connecting client retries, so the first knock wakes the server.
monitor_loop() {
  local interval=10 idle=0 saved=0 fails=0
  local rest="http://127.0.0.1:${REST_API_PORT:-8212}/v1/api"
  local timeout="${AUTO_PAUSE_TIMEOUT_EST:-180}"
  local prev="" resp names count
  while sleep "$interval"; do
    if ! resp=$(curl -sf -m 5 -u "admin:${REST_ADMIN_PASSWORD}" "$rest/players" 2>/dev/null); then
      fails=$((fails + 1))
      [ "$fails" -eq 30 ] && log "monitor: REST API unreachable for ${fails} polls — check REST_API_ENABLED / ADMIN_PASSWORD"
      continue
    fi
    fails=0
    names=$(printf '%s' "$resp" | jq -r '.players[].name' 2>/dev/null | sort) || continue
    count=$(printf '%s' "$names" | grep -c . || true)
    if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
      while IFS= read -r p; do
        [ -n "$p" ] && discord_send PLAYER_JOIN 'player_name has joined Palworld!' "$p"
      done < <(comm -13 <(printf '%s\n' "$prev") <(printf '%s\n' "$names"))
      while IFS= read -r p; do
        [ -n "$p" ] && discord_send PLAYER_LEAVE 'player_name has left Palworld.' "$p"
      done < <(comm -23 <(printf '%s\n' "$prev") <(printf '%s\n' "$names"))
    fi
    prev="$names"
    if [ "${AUTO_PAUSE_ENABLED,,}" = "true" ]; then
      if [ "$count" -eq 0 ]; then idle=$((idle + interval)); else idle=0; saved=0; fi
      if [ "$idle" -ge 30 ] && [ "$saved" -eq 0 ]; then
        [ "${AUTO_PAUSE_LOG,,}" != "false" ] && log "auto-pause: server empty — saving world"
        curl -sf -m 60 -u "admin:${REST_ADMIN_PASSWORD}" -X POST "$rest/save" >/dev/null 2>&1 || true
        saved=1
      fi
      if [ "$idle" -ge "$timeout" ]; then
        curl -sf -m 60 -u "admin:${REST_ADMIN_PASSWORD}" -X POST "$rest/save" >/dev/null 2>&1 || true
        [ "${AUTO_PAUSE_LOG,,}" != "false" ] && log "auto-pause: empty for ${idle}s — pausing game process"
        pkill -STOP -f 'PalServer-Win64-Shipping-Cmd.exe' || true
        tcpdump -i any -c 1 -q "udp and dst port 8211" >/dev/null 2>&1
        pkill -CONT -f 'PalServer-Win64-Shipping-Cmd.exe' || true
        [ "${AUTO_PAUSE_LOG,,}" != "false" ] && log "auto-pause: traffic on game port — resumed"
        idle=0 saved=0
      fi
    fi
  done
}

WINE_BIN=$(command -v wine64 || command -v wine)

# Persistent virtual display (matches ripps818's proven setup)
log "Starting Xvfb on $DISPLAY…"
Xvfb "$DISPLAY" -ac -nolisten tcp -screen 0 640x480x8 &

# One-time wine prefix init + real MSVC 2022 runtime. Wine's built-in CRT is
# incomplete — without vcrun2022 Palworld's save pipeline fails ("Failed to
# save. Failed copy from backup.") and player logins break.
if [ ! -d "$WINEPREFIX" ]; then
  log "Initializing Wine prefix…"
  wineboot --init && wineserver -w
fi
if [ ! -f "$WINEPREFIX/.vcrun2022.done" ]; then
  log "Installing Visual C++ 2022 runtime via winetricks…"
  winetricks --optout -f -q vcrun2022 && touch "$WINEPREFIX/.vcrun2022.done"
fi

# Launch the CONSOLE build (-Cmd) — the windowed shipping exe and the
# PalServer.exe launcher stub both misbehave under Wine.
GAME_BIN="$EXE_DIR/PalServer-Win64-Shipping-Cmd.exe"
START_OPTIONS=(-useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS)
# Steam query port (map it in compose as QUERY_PORT:QUERY_PORT/udp; use a
# distinct value per server on the same host — the default clashes with a
# native-image server's 27015)
START_OPTIONS+=(-queryport="${QUERY_PORT:-27015}")
if [ "${COMMUNITY,,}" = "true" ]; then START_OPTIONS+=(-publiclobby); fi
log "Starting $GAME_BIN under Wine…"
discord_send PRE_START 'Server has been started!'
cd "$SERVER_DIR"
"$WINE_BIN" "$GAME_BIN" "${START_OPTIONS[@]}" &
SERVER_PID=$!
if [ "${AUTO_PAUSE_ENABLED,,}" = "true" ] || [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
  if [ "${REST_API_ENABLED,,}" = "true" ] && [ -n "$REST_ADMIN_PASSWORD" ]; then
    monitor_loop &
    MONITOR_PID=$!
    log "monitor started (auto-pause: ${AUTO_PAUSE_ENABLED:-false}, discord: $([ -n "${DISCORD_WEBHOOK_URL:-}" ] && echo on || echo off))"
  else
    log "monitor NOT started — auto-pause/discord need REST_API_ENABLED=True and ADMIN_PASSWORD"
  fi
fi
wait $SERVER_PID
