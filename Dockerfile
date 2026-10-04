# syntax=docker/dockerfile:1.7
FROM node:24.9.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.9.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/start.js scripts/migrate.js scripts/bootstrap-owner.js ./scripts/
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "scripts/start.js"]
