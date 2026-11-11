# oae-edge-authz: Open Agents Enterprise human-ingress sign-in and authorization (docs/oae/edge-design.md).
FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs ./
# The console's typeface (Instrument Sans, SIL Open Font License: assets/instrument-sans-OFL.txt).
COPY assets ./assets
USER node
EXPOSE 8080
ENTRYPOINT ["node", "server.mjs"]
