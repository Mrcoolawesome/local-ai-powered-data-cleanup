# Zoom presentation-bot spike, stage 1: prove Xvfb + Chromium can render and
# stay live inside a headless container. This is the half of the Zoom bot we
# can build and test entirely ourselves.
#
# Stage 2 (native Zoom Meeting SDK join + startShareView) is NOT in this
# image yet — it needs the actual Linux Meeting SDK tarball from Zoom's
# Marketplace developer portal, which is gated behind an authenticated
# account only the project owner can access. See README.md for the checklist.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    chromium \
    fonts-liberation \
    imagemagick \
    x11-utils \
    procps \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY test-page ./test-page
COPY start-xvfb-chromium.sh ./
RUN chmod +x start-xvfb-chromium.sh

ENTRYPOINT ["./start-xvfb-chromium.sh"]
