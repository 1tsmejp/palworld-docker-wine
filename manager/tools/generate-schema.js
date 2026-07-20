#!/usr/bin/env node
/**
 * Generates config/settings-schema.json from the palworld-server-docker image's
 * own compile-settings.sh + PalWorldSettings.ini.template (dumped from the
 * running container, so the catalog always matches the installed image).
 *
 * Usage: node tools/generate-schema.js
 * Re-run after an image update: dump the two files again (see README) and re-run.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const compile = fs.readFileSync(path.join(__dirname, 'compile-settings.sh'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, 'PalWorldSettings.ini.template'), 'utf8');

// --- 1. template: IniKey=$TEMPLATE_VAR -------------------------------------
const iniToTemplateVar = [];
for (const line of template.split('\n')) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)=("?)\$([A-Z0-9_]+)\2?,?\s*$/) ||
            line.match(/^\s*([A-Za-z0-9_]+)=\$([A-Z0-9_]+),?\s*$/);
  if (!m) continue;
  const iniKey = m[1];
  const tvar = m[3] || m[2];
  iniToTemplateVar.push({ iniKey, templateVar: tvar });
}

// --- 2. compile script: export TEMPLATE_VAR=${USER_ENV:-default} ------------
const exportInfo = {}; // templateVar -> { env, default }
for (const line of compile.split('\n')) {
  const m = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  const tvar = m[1];
  const rhs = m[2];
  const inner = rhs.match(/\$\{([A-Z0-9_]+):-(.*?)\}/);
  if (!inner) continue;
  let def = inner[2].replace(/\\"/g, '').replace(/^"(.*)"$/, '$1');
  exportInfo[tvar] = { env: inner[1], default: def };
}

// --- 3. curated overlay -----------------------------------------------------
// min/max reflect the in-game world-settings ranges from
// https://docs.palworldgame.com/settings-and-operation/configuration/ where
// documented; otherwise sane operational bounds. Edit freely — the backend
// validates against whatever is in settings-schema.json.
const RATE = { min: 0.1, max: 100, step: 0.1 };
const overlay = {
  DIFFICULTY:       { cat: 'World', enum: ['None', 'Casual', 'Normal', 'Hard'], desc: 'Overall difficulty preset. "None" means custom values below apply.' },
  RANDOMIZER_TYPE:  { cat: 'World', enum: ['None', 'Region', 'All'], desc: 'Pal spawn randomizer mode.' },
  RANDOMIZER_SEED:  { cat: 'World', desc: 'Seed for the Pal randomizer.' },
  IS_RANDOMIZER_PAL_LEVEL_RANDOM: { cat: 'World', desc: 'Randomize levels of randomized Pals.' },
  DAYTIME_SPEEDRATE:   { cat: 'World', ...RATE, max: 5, desc: 'Day length multiplier (higher = faster days).' },
  NIGHTTIME_SPEEDRATE: { cat: 'World', ...RATE, max: 5, desc: 'Night length multiplier (higher = faster nights).' },
  EXP_RATE:            { cat: 'Rates & Difficulty', ...RATE, max: 20, desc: 'EXP gain multiplier.' },
  PAL_CAPTURE_RATE:    { cat: 'Rates & Difficulty', min: 0.5, max: 2, step: 0.1, desc: 'Pal capture chance multiplier.' },
  PAL_SPAWN_NUM_RATE:  { cat: 'Pals', min: 0.5, max: 3, step: 0.1, desc: 'Pal spawn count multiplier (high values cost server FPS).' },
  PAL_DAMAGE_RATE_ATTACK:  { cat: 'Pals', ...RATE, max: 5, desc: 'Damage dealt by Pals multiplier.' },
  PAL_DAMAGE_RATE_DEFENSE: { cat: 'Pals', ...RATE, max: 5, desc: 'Damage taken by Pals multiplier.' },
  PLAYER_DAMAGE_RATE_ATTACK:  { cat: 'Player', ...RATE, max: 5, desc: 'Damage dealt by players multiplier.' },
  PLAYER_DAMAGE_RATE_DEFENSE: { cat: 'Player', ...RATE, max: 5, desc: 'Damage taken by players multiplier.' },
  PLAYER_STOMACH_DECREASE_RATE: { cat: 'Player', ...RATE, max: 5, desc: 'Player hunger drain multiplier.' },
  PLAYER_STAMINA_DECREASE_RATE: { cat: 'Player', ...RATE, max: 5, desc: 'Player stamina drain multiplier.' },
  PLAYER_AUTO_HP_REGEN_RATE:          { cat: 'Player', ...RATE, max: 5, desc: 'Player HP regen multiplier.' },
  PLAYER_AUTO_HP_REGEN_RATE_IN_SLEEP: { cat: 'Player', ...RATE, max: 5, desc: 'Player HP regen while sleeping multiplier.' },
  PAL_STOMACH_DECREASE_RATE: { cat: 'Pals', ...RATE, max: 5, desc: 'Pal hunger drain multiplier.' },
  PAL_STAMINA_DECREASE_RATE: { cat: 'Pals', ...RATE, max: 5, desc: 'Pal stamina drain multiplier.' },
  PAL_AUTO_HP_REGEN_RATE:          { cat: 'Pals', ...RATE, max: 5, desc: 'Pal HP regen multiplier.' },
  PAL_AUTO_HP_REGEN_RATE_IN_SLEEP: { cat: 'Pals', ...RATE, max: 5, desc: 'Pal HP regen in Palbox multiplier.' },
  BUILD_OBJECT_HP_RATE:     { cat: 'Building', min: 0.5, max: 3, step: 0.1, desc: 'Structure HP multiplier.' },
  BUILD_OBJECT_DAMAGE_RATE: { cat: 'Building', min: 0.5, max: 3, step: 0.1, desc: 'Damage to structures multiplier.' },
  BUILD_OBJECT_DETERIORATION_DAMAGE_RATE: { cat: 'Building', min: 0, max: 10, step: 0.1, desc: 'Structure deterioration rate (0 disables decay).' },
  COLLECTION_DROP_RATE:  { cat: 'Items & Drops', min: 0.5, max: 3, step: 0.1, desc: 'Gathering yield multiplier.' },
  COLLECTION_OBJECT_HP_RATE: { cat: 'Items & Drops', min: 0.5, max: 3, step: 0.1, desc: 'Gatherable object HP multiplier.' },
  COLLECTION_OBJECT_RESPAWN_SPEED_RATE: { cat: 'Items & Drops', min: 0.5, max: 3, step: 0.1, desc: 'Gatherable respawn interval multiplier (higher = slower).' },
  ENEMY_DROP_ITEM_RATE:  { cat: 'Items & Drops', min: 0.5, max: 3, step: 0.1, desc: 'Enemy loot drop multiplier.' },
  DEATH_PENALTY: { cat: 'Player', enum: ['None', 'Item', 'ItemAndEquipment', 'All'], desc: 'What is dropped on death: nothing / items / items+equipment / everything incl. Pals.' },
  ENABLE_PLAYER_TO_PLAYER_DAMAGE: { cat: 'PvP', desc: 'Players can damage each other.' },
  ENABLE_FRIENDLY_FIRE: { cat: 'PvP', desc: 'Friendly fire within guilds.' },
  ENABLE_INVADER_ENEMY: { cat: 'World', desc: 'Enable base raids by invaders.' },
  ACTIVE_UNKO: { cat: 'World', desc: 'Enable UNKO (poop mechanics easter egg).' },
  ENABLE_AIM_ASSIST_PAD:      { cat: 'Player', desc: 'Aim assist for controllers.' },
  ENABLE_AIM_ASSIST_KEYBOARD: { cat: 'Player', desc: 'Aim assist for keyboard/mouse.' },
  DROP_ITEM_MAX_NUM:      { cat: 'Items & Drops', min: 0, max: 5000, step: 100, desc: 'Max dropped items in the world (high values cost performance).' },
  DROP_ITEM_MAX_NUM_UNKO: { cat: 'Items & Drops', min: 0, max: 5000, step: 10, desc: 'Max UNKO items in the world.' },
  BASE_CAMP_MAX_NUM:        { cat: 'Base Camp & Guilds', min: 0, max: 512, step: 1, desc: 'Max base camps server-wide.' },
  BASE_CAMP_WORKER_MAX_NUM: { cat: 'Base Camp & Guilds', min: 0, max: 50, step: 1, desc: 'Max worker Pals per base camp.' },
  DROP_ITEM_ALIVE_MAX_HOURS: { cat: 'Items & Drops', min: 0, max: 240, step: 0.5, desc: 'Hours before dropped items despawn.' },
  AUTO_RESET_GUILD_NO_ONLINE_PLAYERS: { cat: 'Base Camp & Guilds', desc: 'Auto-disband guilds with no online players.' },
  AUTO_RESET_GUILD_TIME_NO_ONLINE_PLAYERS: { cat: 'Base Camp & Guilds', min: 1, max: 8760, step: 1, desc: 'Hours of guild inactivity before auto-reset.' },
  GUILD_PLAYER_MAX_NUM:       { cat: 'Base Camp & Guilds', min: 1, max: 100, step: 1, desc: 'Max players per guild.' },
  BASE_CAMP_MAX_NUM_IN_GUILD: { cat: 'Base Camp & Guilds', min: 1, max: 10, step: 1, desc: 'Max base camps per guild.' },
  PAL_EGG_DEFAULT_HATCHING_TIME: { cat: 'Pals', min: 0, max: 240, step: 0.5, desc: 'Hours for the largest eggs to hatch (0 = instant).' },
  WORK_SPEED_RATE: { cat: 'Rates & Difficulty', ...RATE, max: 5, desc: 'Pal work speed multiplier.' },
  AUTO_SAVE_SPAN:  { cat: 'Server & Admin', min: 30, max: 3600, step: 30, desc: 'World autosave interval in seconds.' },
  IS_MULTIPLAY: { cat: 'World', desc: 'Multiplayer world mode flag.' },
  IS_PVP:       { cat: 'PvP', desc: 'Enable PvP mode.' },
  HARDCORE:     { cat: 'World', desc: 'Hardcore mode (permadeath).' },
  CHARACTER_RECREATE_IN_HARDCORE: { cat: 'World', desc: 'Allow character re-creation after hardcore death.' },
  PAL_LOST: { cat: 'Pals', desc: 'Pals are permanently lost on death.' },
  CAN_PICKUP_OTHER_GUILD_DEATH_PENALTY_DROP: { cat: 'PvP', desc: 'Other guilds can loot your death drops.' },
  ENABLE_NON_LOGIN_PENALTY: { cat: 'Server & Admin', desc: 'Penalty for players who have not logged in recently.' },
  ENABLE_FAST_TRAVEL: { cat: 'World', desc: 'Enable fast travel.' },
  IS_START_LOCATION_SELECT_BY_MAP: { cat: 'World', desc: 'New players choose start location on the map.' },
  EXIST_PLAYER_AFTER_LOGOUT: { cat: 'World', desc: 'Player bodies remain in the world after logout.' },
  ENABLE_DEFENSE_OTHER_GUILD_PLAYER: { cat: 'PvP', desc: 'Defense against other guild players.' },
  INVISIBLE_OTHER_GUILD_BASE_CAMP_AREA_FX: { cat: 'Base Camp & Guilds', desc: 'Hide other guilds\' base camp area effects.' },
  BUILD_AREA_LIMIT: { cat: 'Building', desc: 'Restrict building near certain areas.' },
  ITEM_WEIGHT_RATE: { cat: 'Items & Drops', ...RATE, max: 5, desc: 'Item weight multiplier (lower = carry more).' },
  COOP_PLAYER_MAX_NUM: { cat: 'Network & Access', min: 1, max: 8, step: 1, desc: 'Max players in a coop (invite-code) session.' },
  PLAYERS: { cat: 'Network & Access', min: 1, max: 32, step: 1, desc: 'Max players on the server (ServerPlayerMaxNum).' },
  SERVER_NAME:        { cat: 'General', desc: 'Server name shown in browser.' },
  SERVER_DESCRIPTION: { cat: 'General', desc: 'Server description shown in browser.' },
  ADMIN_PASSWORD: { cat: 'Server & Admin', sensitive: true, desc: 'Admin password (also used for RCON / REST API auth).' },
  SERVER_PASSWORD: { cat: 'Network & Access', sensitive: true, desc: 'Password required to join the server.' },
  PUBLIC_PORT: { cat: 'Network & Access', min: 1024, max: 65535, step: 1, desc: 'Public port advertised to the community browser.' },
  PUBLIC_IP:   { cat: 'Network & Access', desc: 'Public IP advertised to the community browser (auto-detected if empty).' },
  RCON_ENABLED: { cat: 'Server & Admin', desc: 'Enable RCON (REST API is preferred).' },
  RCON_PORT:    { cat: 'Server & Admin', min: 1024, max: 65535, step: 1, desc: 'RCON port.' },
  REGION:  { cat: 'Network & Access', desc: 'Server region string.' },
  USEAUTH: { cat: 'Network & Access', desc: 'Use authentication for connections.' },
  BAN_LIST_URL: { cat: 'Server & Admin', desc: 'URL of the ban list.' },
  REST_API_ENABLED: { cat: 'Server & Admin', desc: 'Enable REST API (required by this manager for announce/validate).', critical: 'The manager uses the REST API — disabling it breaks announcements, graceful reboots and validation.' },
  REST_API_PORT: { cat: 'Server & Admin', min: 1024, max: 65535, step: 1, desc: 'REST API port. DO NOT forward this port to the internet.' },
  SHOW_PLAYER_LIST: { cat: 'Network & Access', desc: 'Show player list in the server browser.' },
  CHAT_POST_LIMIT_PER_MINUTE: { cat: 'Server & Admin', min: 0, max: 1000, step: 1, desc: 'Max chat messages per player per minute.' },
  USE_BACKUP_SAVE_DATA: { cat: 'Server & Admin', desc: 'Enable Palworld\'s own rolling save backups.' },
  SUPPLY_DROP_SPAN: { cat: 'World', min: 30, max: 3600, step: 10, desc: 'Minutes between supply drops.' },
  ENABLE_PREDATOR_BOSS_PAL: { cat: 'Pals', desc: 'Enable predator boss Pals.' },
  MAX_BUILDING_LIMIT_NUM: { cat: 'Building', min: 0, max: 100000, step: 100, desc: 'Max structures per player (0 = unlimited).' },
  SERVER_REPLICATE_PAWN_CULL_DISTANCE: { cat: 'Server & Admin', min: 5000, max: 15000, step: 500, desc: 'Distance (units) at which pawns replicate to clients.' },
  CROSSPLAY_PLATFORMS: { cat: 'Network & Access', pattern: '^\\(.*\\)$', patternHint: 'must be wrapped in parentheses, e.g. (Steam,Xbox,PS5,Mac)', desc: 'Allowed platforms — parentheses required, e.g. (Steam,Xbox,PS5,Mac).' },
  ALLOW_GLOBAL_PALBOX_EXPORT: { cat: 'Pals', desc: 'Allow exporting Pals to the Global Palbox.' },
  ALLOW_GLOBAL_PALBOX_IMPORT: { cat: 'Pals', desc: 'Allow importing Pals from the Global Palbox.' },
  EQUIPMENT_DURABILITY_DAMAGE_RATE: { cat: 'Items & Drops', min: 0, max: 5, step: 0.1, desc: 'Equipment durability loss multiplier (0 = no durability loss).' },
  ITEM_CONTAINER_FORCE_MARK_DIRTY_INTERVAL: { cat: 'Server & Admin', min: 0.1, max: 60, step: 0.1, desc: 'Container sync interval (seconds).' },
  ITEM_CORRUPTION_MULTIPLIER: { cat: 'Items & Drops', min: 0, max: 10, step: 0.1, desc: 'Food spoilage speed multiplier.' },
  PHYSICS_ACTIVE_DROP_ITEM_MAX_NUM: { cat: 'Items & Drops', min: -1, max: 5000, step: 1, desc: 'Max physics-active dropped items (-1 = engine default).' },
  ALLOW_CLIENT_MOD: { cat: 'Server & Admin', desc: 'Allow client-side mods.' },
  PLAYER_DATA_PAL_STORAGE_UPDATE_CHECK_TICK_INTERVAL: { cat: 'Server & Admin', min: 0.1, max: 60, step: 0.1, desc: 'Pal storage update check interval (seconds).' },
  LOG_FORMAT_TYPE: { cat: 'Server & Admin', enum: ['default', 'Text', 'Json', 'json', 'logfmt', 'colored', 'plain'], desc: 'Server log format.' },
  IS_SHOW_JOIN_LEFT_MESSAGE: { cat: 'Server & Admin', desc: 'Broadcast join/leave messages in chat.' },
  MONSTER_FARM_ACTION_SPEED_RATE: { cat: 'Pals', min: 0.1, max: 5, step: 0.1, desc: 'Ranch Pal action speed multiplier.' },
  DENY_TECHNOLOGY_LIST: { cat: 'World', desc: 'Comma-separated technology IDs to block.' },
  GUILD_REJOIN_COOLDOWN_MINUTES: { cat: 'Base Camp & Guilds', min: 0, max: 10080, step: 1, desc: 'Cooldown before rejoining a guild (minutes).' },
  AUTO_TRANSFER_MASTER_CHECK_INTERVAL_SECONDS: { cat: 'Base Camp & Guilds', min: 60, max: 86400, step: 60, desc: 'How often to check for inactive guild masters (seconds).' },
  AUTO_TRANSFER_MASTER_THRESHOLD_DAYS: { cat: 'Base Camp & Guilds', min: 1, max: 365, step: 1, desc: 'Days of guild-master inactivity before mastership transfers.' },
  MAX_GUILDS_PER_FRAME: { cat: 'Server & Admin', min: 1, max: 100, step: 1, desc: 'Guilds processed per server tick.' },
  BLOCK_RESPAWN_TIME: { cat: 'Player', min: 0, max: 300, step: 1, desc: 'Respawn block time (seconds).' },
  RESPAWN_PENALTY_DURATION_THRESHOLD: { cat: 'Player', min: 0, max: 3600, step: 1, desc: 'Threshold before respawn penalty applies (seconds).' },
  RESPAWN_PENALTY_TIME_SCALE: { cat: 'Player', min: 0, max: 10, step: 0.1, desc: 'Respawn penalty time scaling.' },
  DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_BASE_CAMP: { cat: 'PvP', desc: 'Show PvP item counts for base camps on the map.' },
  DISPLAY_PVP_ITEM_NUM_ON_WORLD_MAP_PLAYER: { cat: 'PvP', desc: 'Show PvP item counts for players on the map.' },
  ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE: { cat: 'PvP', desc: 'Extra drop type on PvP kill.' },
  ADDITIONAL_DROP_ITEM_NUM_WHEN_PLAYER_KILLING_IN_PVP_MODE: { cat: 'PvP', min: 0, max: 100, step: 1, desc: 'Extra drop count on PvP kill.' },
  ADDITIONAL_DROP_ITEM_WHEN_PLAYER_KILLING_IN_PVP_MODE_ENABLED: { cat: 'PvP', desc: 'Enable extra drops on PvP kill.' },
  ENABLE_VOICE_CHAT: { cat: 'Voice & Chat', desc: 'Enable proximity voice chat.' },
  VOICE_CHAT_MAX_VOLUME_DISTANCE:  { cat: 'Voice & Chat', min: 100, max: 100000, step: 100, desc: 'Distance of full voice volume (units).' },
  VOICE_CHAT_ZERO_VOLUME_DISTANCE: { cat: 'Voice & Chat', min: 100, max: 200000, step: 100, desc: 'Distance at which voice fades to zero (units).' },
  ALLOW_ENHANCE_STAT_HEALTH:     { cat: 'Player', desc: 'Allow enhancing Health stat.' },
  ALLOW_ENHANCE_STAT_ATTACK:     { cat: 'Player', desc: 'Allow enhancing Attack stat.' },
  ALLOW_ENHANCE_STAT_STAMINA:    { cat: 'Player', desc: 'Allow enhancing Stamina stat.' },
  ALLOW_ENHANCE_STAT_WEIGHT:     { cat: 'Player', desc: 'Allow enhancing Weight stat.' },
  ALLOW_ENHANCE_STAT_WORK_SPEED: { cat: 'Player', desc: 'Allow enhancing Work Speed stat.' },
  ENABLE_BUILDING_PLAYER_UID_DISPLAY: { cat: 'Building', desc: 'Show builder UID on structures.' },
  BUILDING_NAME_DISPLAY_CACHE_TTL_SECONDS: { cat: 'Building', min: 1, max: 3600, step: 1, desc: 'Builder-name display cache TTL (seconds).' },
};

// ---------------------------------------------------------------------------
// Image-level settings (thijsvanloef/palworld-server-docker features, not part
// of PalWorldSettings.ini): https://github.com/thijsvanloef/palworld-server-docker
// scope:'image' -> validated against container env after deploy, not REST API.
const CRON = { pattern: '^\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+$', patternHint: 'must be a 5-field cron expression, e.g. 0 4 * * *' };
const IMAGE_SETTINGS = [
  // Server visibility (launch flag, not an ini key — hence image scope)
  { env: 'COMMUNITY', type: 'boolean', default: false, cat: 'Network & Access', desc: 'List the server in the community server browser (-publiclobby). Use together with SERVER_PASSWORD, and make sure your game port is forwarded.' },
  // Auto pause
  { env: 'AUTO_PAUSE_ENABLED', type: 'boolean', default: false, cat: 'Image: Auto Pause', desc: 'Pause the server process when no players are online (world time stops; wakes on connection).', requires: { ENABLE_PLAYER_LOGGING: true, REST_API_ENABLED: true } },
  { env: 'AUTO_PAUSE_TIMEOUT_EST', type: 'integer', default: 180, min: 10, max: 86400, step: 10, cat: 'Image: Auto Pause', desc: 'Seconds after the last player leaves before the server pauses.' },
  { env: 'AUTO_PAUSE_LOG', type: 'boolean', default: true, cat: 'Image: Auto Pause', desc: 'Log auto-pause activity.' },
  { env: 'AUTO_PAUSE_DEBUG', type: 'boolean', default: false, cat: 'Image: Auto Pause', desc: 'Verbose auto-pause debug logging.' },
  // Auto reboot
  { env: 'AUTO_REBOOT_ENABLED', type: 'boolean', default: false, cat: 'Image: Auto Reboot', desc: 'Scheduled in-container reboots via cron.', requires: { RCON_ENABLED: true } },
  { env: 'AUTO_REBOOT_CRON_EXPRESSION', type: 'string', default: '0 0 * * *', ...CRON, cat: 'Image: Auto Reboot', desc: 'Cron schedule for automatic reboots (container timezone TZ).' },
  { env: 'AUTO_REBOOT_WARN_MINUTES', type: 'integer', default: 5, min: 0, max: 120, step: 1, cat: 'Image: Auto Reboot', desc: 'Minutes of in-game warning before a scheduled reboot.' },
  { env: 'AUTO_REBOOT_EVEN_IF_PLAYERS_ONLINE', type: 'boolean', default: false, cat: 'Image: Auto Reboot', desc: 'Reboot on schedule even when players are online.' },
  // Auto update
  { env: 'AUTO_UPDATE_ENABLED', type: 'boolean', default: false, cat: 'Image: Auto Update', desc: 'Automatically update the game server on a cron schedule.', requires: { RCON_ENABLED: true, UPDATE_ON_BOOT: true } },
  { env: 'AUTO_UPDATE_CRON_EXPRESSION', type: 'string', default: '0 * * * *', ...CRON, cat: 'Image: Auto Update', desc: 'Cron schedule for update checks.' },
  { env: 'AUTO_UPDATE_WARN_MINUTES', type: 'integer', default: 30, min: 0, max: 120, step: 1, cat: 'Image: Auto Update', desc: 'Minutes of warning before an update restart (ignored when empty server).' },
  { env: 'UPDATE_ON_BOOT', type: 'boolean', default: true, cat: 'Image: Auto Update', desc: 'Update/validate the server files on container start.' },
  { env: 'TARGET_MANIFEST_ID', type: 'string', default: '', cat: 'Image: Auto Update', desc: 'Pin the server to a specific Steam depot manifest (version lock).' },
  { env: 'STEAM_USERNAME', type: 'string', default: '', cat: 'Image: Auto Update', desc: 'Steam account (needed for version locking and Workshop mod downloads).' },
  { env: 'STEAM_PASSWORD', type: 'string', default: '', sensitive: true, cat: 'Image: Auto Update', desc: 'Steam password for STEAM_USERNAME.' },
  // Backups
  { env: 'BACKUP_ENABLED', type: 'boolean', default: true, cat: 'Image: Backups', desc: 'Automatic scheduled backups of the save data.' },
  { env: 'BACKUP_CRON_EXPRESSION', type: 'string', default: '0 0 * * *', ...CRON, cat: 'Image: Backups', desc: 'Cron schedule for automatic backups.' },
  { env: 'DELETE_OLD_BACKUPS', type: 'boolean', default: false, cat: 'Image: Backups', desc: 'Automatically delete backups older than OLD_BACKUP_DAYS.' },
  { env: 'OLD_BACKUP_DAYS', type: 'integer', default: 30, min: 1, max: 365, step: 1, cat: 'Image: Backups', desc: 'Days to keep backups when DELETE_OLD_BACKUPS is on.' },
  // Logging / monitoring
  { env: 'ENABLE_PLAYER_LOGGING', type: 'boolean', default: true, cat: 'Image: Logging', desc: 'Log player joins/leaves (required by auto-pause).', requires: { REST_API_ENABLED: true } },
  { env: 'PLAYER_LOGGING_POLL_PERIOD', type: 'integer', default: 5, min: 1, max: 60, step: 1, cat: 'Image: Logging', desc: 'Seconds between player-list polls.' },
  { env: 'LOG_FILTER_ENABLED', type: 'boolean', default: true, cat: 'Image: Logging', desc: 'Filter duplicate/noisy log lines.' },
  { env: 'LOG_LEVEL', type: 'enum', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR', 'OFF'], default: 'INFO', cat: 'Image: Logging', desc: 'Minimum container log level.' },
  { env: 'TZ', type: 'string', default: 'UTC', cat: 'Image: Logging', desc: 'Container timezone (affects cron schedules and timestamps).' },
  // Discord (base)
  { env: 'DISCORD_WEBHOOK_URL', type: 'string', default: '', sensitive: true, cat: 'Image: Discord', desc: 'Discord webhook URL for event notifications.' },
  { env: 'DISCORD_SUPPRESS_NOTIFICATIONS', type: 'boolean', default: false, cat: 'Image: Discord', desc: 'Send Discord messages silently (@silent).' },
  { env: 'DISCORD_CONNECT_TIMEOUT', type: 'integer', default: 30, min: 1, max: 300, step: 1, cat: 'Image: Discord', desc: 'Webhook connect timeout (seconds).' },
  { env: 'DISCORD_MAX_TIMEOUT', type: 'integer', default: 30, min: 1, max: 300, step: 1, cat: 'Image: Discord', desc: 'Webhook total timeout (seconds).' },
];
// Per-event Discord triplets (ENABLED/MESSAGE/URL)
const DISCORD_EVENTS = [
  ['PRE_UPDATE_BOOT', 'Server is updating...'],
  ['POST_UPDATE_BOOT', 'Server update complete!'],
  ['PRE_START', 'Server has been started!'],
  ['PRE_SHUTDOWN', 'Server is shutting down...'],
  ['POST_SHUTDOWN', 'Server is stopped!'],
  ['PLAYER_JOIN', 'player_name has joined Palworld!'],
  ['PLAYER_LEAVE', 'player_name has left Palworld.'],
  ['PRE_BACKUP', 'Creating backup...'],
  ['POST_BACKUP', 'Backup created at file_path'],
  ['PRE_BACKUP_DELETE', 'Removing backups older than old_backup_days days'],
  ['POST_BACKUP_DELETE', 'Removed backups older than old_backup_days days'],
];
for (const [ev, defMsg] of DISCORD_EVENTS) {
  IMAGE_SETTINGS.push(
    { env: `DISCORD_${ev}_MESSAGE_ENABLED`, type: 'boolean', default: true, cat: 'Image: Discord', desc: `Enable the ${ev.toLowerCase().replace(/_/g, ' ')} Discord message.` },
    { env: `DISCORD_${ev}_MESSAGE`, type: 'string', default: defMsg, cat: 'Image: Discord', desc: `Message for the ${ev.toLowerCase().replace(/_/g, ' ')} event.` },
    { env: `DISCORD_${ev}_MESSAGE_URL`, type: 'string', default: '', cat: 'Image: Discord', desc: `Override webhook URL for this event (falls back to DISCORD_WEBHOOK_URL).` },
  );
}

function inferType(def, env) {
  if (/^(True|False)$/i.test(def)) return 'boolean';
  if (/^-?\d+$/.test(def)) return 'integer';
  if (/^-?\d*\.\d+$/.test(def)) return 'number';
  return 'string';
}

const settings = [];
for (const { iniKey, templateVar } of iniToTemplateVar) {
  const info = exportInfo[templateVar];
  if (!info) continue;
  const o = overlay[info.env] || {};
  const type = o.enum ? 'enum' : inferType(info.default, info.env);
  let def = info.default;
  if (type === 'integer') def = parseInt(def, 10);
  else if (type === 'number') def = parseFloat(def);
  else if (type === 'boolean') def = /^true$/i.test(def);
  const entry = {
    env: info.env,
    iniKey,
    type,
    default: def,
    category: o.cat || 'Other',
    description: o.desc || '',
  };
  if (o.enum) entry.enum = o.enum;
  if (o.min !== undefined) entry.min = o.min;
  if (o.max !== undefined) entry.max = o.max;
  if (o.step !== undefined) entry.step = o.step;
  if (o.sensitive) entry.sensitive = true;
  if (o.critical) entry.critical = o.critical;
  if (o.pattern) { entry.pattern = o.pattern; entry.patternHint = o.patternHint; }
  entry.scope = 'game';
  settings.push(entry);
}

for (const s of IMAGE_SETTINGS) {
  const entry = {
    env: s.env, iniKey: null, type: s.type, default: s.default,
    category: s.cat, description: s.desc, scope: 'image',
  };
  for (const k of ['enum', 'min', 'max', 'step', 'sensitive', 'pattern', 'patternHint', 'requires']) {
    if (s[k] !== undefined) entry[k] = s[k];
  }
  settings.push(entry);
}

const out = {
  $comment: 'Generated by tools/generate-schema.js from the running palworld-server-docker image. Min/max are editable guardrails used by the manager UI and API validation.',
  generatedFor: 'thijsvanloef/palworld-server-docker',
  categories: ['General', 'Network & Access', 'Rates & Difficulty', 'World', 'Player', 'Pals', 'Items & Drops', 'Base Camp & Guilds', 'Building', 'PvP', 'Voice & Chat', 'Server & Admin', 'Image: Auto Pause', 'Image: Auto Reboot', 'Image: Auto Update', 'Image: Backups', 'Image: Logging', 'Image: Discord', 'Other'],
  settings,
};
fs.writeFileSync(path.join(root, 'config', 'settings-schema.json'), JSON.stringify(out, null, 2));
console.log(`Wrote ${settings.length} settings to config/settings-schema.json`);
const uncat = settings.filter(s => s.category === 'Other').map(s => s.env);
if (uncat.length) console.log('Uncategorized:', uncat.join(', '));
