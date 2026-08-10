# Production Zoom Bot Service — same known-working environment as the
# validated spike's Dockerfile.integration-test (debian:bookworm-slim, not
# Ubuntu: Ubuntu's `chromium` package is a snap stub that doesn't run in a
# container, confirmed the hard way — spikes/zoom-presentation-bot/Dockerfile).
#
# Deliberately does NOT COPY the proprietary Zoom SDK in — it's bind-mounted
# at runtime instead (docker-compose.yml, start.sh's build step) so it's
# never baked into this image, matching "never redistribute" from
# spikes/zoom-presentation-bot/README.md.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    chromium \
    x11-utils \
    xdotool \
    cmake \
    make \
    g++ \
    qt6-base-dev \
    libssl-dev \
    fonts-liberation \
    procps \
    # Transitive runtime deps of the SDK's bundled Qt6/libmeetingsdk.so —
    # not obvious from the SDK's own docs (spikes/zoom-presentation-bot/README.md).
    libatomic1 \
    libxcb-cursor0 \
    libxcb-xtest0 \
    libxkbcommon-x11-0 \
    libnss3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY CMakeLists.txt ./
COPY src ./src
COPY start.sh ./
RUN chmod +x start.sh

ENTRYPOINT ["./start.sh"]
