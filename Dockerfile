# STRABFAHRT als Container, z. B. auf einem Raspberry Pi oder kleinen Server.
#   docker build -t strabfahrt .
#   docker run -d --name strabfahrt -p 3000:3000 -v strabfahrt-data:/app/data --restart unless-stopped strabfahrt
# Beim ersten Start werden die Fahrplan-Feeds geladen (einige Minuten). Neu bauen: docker exec strabfahrt npm run build:data
# und danach docker restart strabfahrt.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV HOST=0.0.0.0 PORT=3000 NODE_OPTIONS=--max-old-space-size=4096
EXPOSE 3000
USER node
CMD ["node", "scripts/dev.mjs", "--no-open"]
