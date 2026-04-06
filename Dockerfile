FROM oven/bun:1 AS base

WORKDIR /app

COPY package.json ./
COPY bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src

ENV OPENAI_RESPONSES_PROXY_HOST=0.0.0.0
EXPOSE 4141

CMD ["bun", "run", "start"]
