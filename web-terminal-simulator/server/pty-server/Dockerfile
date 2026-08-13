# term — real PTY backend (MODE 2)
# Build:  docker build -t term-pty ./server/pty-server
# Run:    docker compose -f server/pty-server/docker-compose.yml up -d

FROM node:20-bookworm-slim

# node-pty is a native module: it needs build tools at install time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Never run the shell as root.
RUN groupadd -r term -g 1000 \
    && useradd -r -g term -u 1000 -m -d /home/term -s /bin/bash term

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.mjs ./

USER term
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
