FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config.json ./
COPY src ./src
RUN mkdir .data && chown node:node .data
USER node
VOLUME /app/.data
CMD ["node", "src/main.ts"]
