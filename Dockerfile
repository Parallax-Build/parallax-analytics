# One image for every Parallax service. TypeScript runs directly on Node 24
# (type stripping), so there is no build step and no compiled output to drift.
FROM node:24-alpine

WORKDIR /app
RUN npm install -g pnpm@11.23.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/path-rules/package.json packages/path-rules/
COPY apps/gateway/package.json apps/gateway/
COPY apps/core/package.json apps/core/
COPY examples/sample-api/package.json examples/sample-api/
RUN pnpm install --frozen-lockfile --prod

COPY packages packages
COPY apps apps
COPY db db
COPY deploy deploy
COPY examples examples

USER node
ENV NODE_ENV=production
CMD ["node", "apps/core/src/main.ts"]
