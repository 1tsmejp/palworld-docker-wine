# EXPERIMENTAL: Palworld WINDOWS dedicated server under Wine.
# Purpose: full mod support (UE4SS / PalSchema / Lua / official Workshop mod
# system) which is Windows-only — the native Linux server can only sideload
# pak mods. Run as an isolated test stack next to the production server.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture i386 \
 && sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && echo "steam steam/question select I AGREE" | debconf-set-selections \
 && echo "steam steam/license note ''" | debconf-set-selections \
 && apt-get install -y --no-install-recommends \
      steamcmd wine wine64 wine32:i386 xvfb xauth ca-certificates procps gettext-base winbind \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 steam
COPY entrypoint.sh /entrypoint.sh
COPY PalWorldSettings.ini.template /home/steam/PalWorldSettings.ini.template
RUN chmod +x /entrypoint.sh && mkdir -p /palworld && chown steam:steam /palworld

USER steam
ENV HOME=/home/steam \
    WINEPREFIX=/home/steam/.wine \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES="mscoree,mshtml="

EXPOSE 8211/udp 8212/tcp
VOLUME /palworld
ENTRYPOINT ["/entrypoint.sh"]
