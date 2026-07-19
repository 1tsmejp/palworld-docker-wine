FROM node:22-alpine

# docker CLI + compose plugin: the manager recreates the Palworld container
# through the host's docker socket.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY config ./config
COPY tools ./tools

ENV NODE_ENV=production
EXPOSE 8220
CMD ["node", "server/index.js"]
