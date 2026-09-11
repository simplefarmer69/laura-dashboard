# LAURA swarm runtime — one always-on process (Next.js server + in-process
# autopilot). Mount a persistent volume at /data: state, archive, backups,
# launch art and agent-authored library docs all live there.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SWARM_DATA_DIR=/data \
    PORT=4747
COPY --from=build /app ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 4747
CMD ["npm", "run", "start:host"]
