# EXPERIMENTAL: Palworld WINDOWS dedicated server under Wine.
# Purpose: full mod support (UE4SS / PalSchema / Lua / official Workshop mod
# system) which is Windows-only — the native Linux server can only sideload
# pak mods. Wine specifics aligned with the proven setup in
# https://github.com/ripps818/docker-palworld-dedicated-server-wine :
# WineHQ stable, winetricks vcrun2022, persistent Xvfb, and launching the
# console build PalServer-Win64-Shipping-Cmd.exe.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture i386 \
 && apt-get update && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && (sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
     || sed -i 's/ main/ main contrib non-free non-free-firmware/' /etc/apt/sources.list) \
 && mkdir -p /etc/apt/keyrings \
 && wget -qO /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
 && wget -qNP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/debian/dists/bookworm/winehq-bookworm.sources \
 && apt-get update \
 && echo "steam steam/question select I AGREE" | debconf-set-selections \
 && echo "steam steam/license note ''" | debconf-set-selections \
 && apt-get install -y --install-recommends winehq-stable \
 && apt-get install -y --no-install-recommends \
      steamcmd xvfb xauth procps gettext-base winbind cabextract \
 && wget -qO /usr/local/bin/winetricks https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks \
 && chmod +x /usr/local/bin/winetricks \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# DepotDownloader — used for Steam-authenticated Workshop mod downloads
# (management tooling shells into this container to run it).
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
 && wget -qO /tmp/dd.zip https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_3.4.0/DepotDownloader-linux-x64.zip \
 && unzip -o /tmp/dd.zip -d /usr/local/bin DepotDownloader \
 && chmod +x /usr/local/bin/DepotDownloader && rm /tmp/dd.zip \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 steam
COPY entrypoint.sh /entrypoint.sh
COPY PalWorldSettings.ini.template /home/steam/PalWorldSettings.ini.template
RUN chmod +x /entrypoint.sh && mkdir -p /palworld && chown steam:steam /palworld

USER steam
ENV HOME=/home/steam \
    WINEPREFIX=/home/steam/.wine \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES="mscoree,mshtml=" \
    DISPLAY=:99

EXPOSE 8211/udp 8212/tcp
VOLUME /palworld
ENTRYPOINT ["/entrypoint.sh"]
