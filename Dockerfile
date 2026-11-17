FROM node:20-bookworm-slim

# CloakBrowser ships its own patched Chromium but needs Chromium's runtime
# libraries and a real X display: it runs HEADED under Xvfb. ffmpeg grabs that
# display for the livestream.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb ffmpeg ca-certificates curl \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libgtk-3-0 libxtst6 libxi6 libxshmfence1 libxcursor1 libxinerama1 \
    fonts-liberation fonts-croscore \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# the browser goes INTO the image at build time
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser
RUN npx cloakbrowser install && test -n "$(find /opt/cloakbrowser -name chrome -type f)"
RUN CHROME="$(find /opt/cloakbrowser -name chrome -type f | head -1)" \
 && if ldd "$CHROME" | grep "not found"; then echo "missing shared libraries above"; exit 1; \
    else echo "every shared library resolves"; fi

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY . .

ENV HEADLESS=false
ENV CLOAKBROWSER_SUPPRESS_FONT_WARNING=1
ENV NODE_OPTIONS=--unhandled-rejections=warn

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
