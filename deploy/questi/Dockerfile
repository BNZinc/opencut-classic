# 퀘스티 영상 편집기 (questivideoeditor): OpenCut's editor as the TA app frames it (src/questi/bridge.ts).
# Built from the repository root: docker build -f deploy/questi/Dockerfile .
FROM node:22-bookworm AS build
RUN npm install --global bun@1.2.18
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
WORKDIR /src/apps/web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN ./node_modules/.bin/next build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /src/apps/web/public ./apps/web/public
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
