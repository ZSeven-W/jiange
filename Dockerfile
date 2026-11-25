# Multi-stage build: compile workspace SDKs + web frontend, embed into the Go server,
# and ship a static binary. Nothing is read from the repo at runtime.
FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/base-sdk/package.json packages/base-sdk/
COPY packages/base-ui/package.json packages/base-ui/
COPY packages/collab/package.json packages/collab/
COPY packages/doc-sdk/package.json packages/doc-sdk/
COPY packages/doc-ui/package.json packages/doc-ui/
COPY packages/ooxml/package.json packages/ooxml/
COPY packages/render-gpu/package.json packages/render-gpu/
COPY packages/sheet-sdk/package.json packages/sheet-sdk/
COPY packages/sheet-ui/package.json packages/sheet-ui/
COPY packages/slides-sdk/package.json packages/slides-sdk/
COPY packages/slides-ui/package.json packages/slides-ui/
COPY packages/whiteboard-sdk/package.json packages/whiteboard-sdk/
COPY packages/whiteboard-ui/package.json packages/whiteboard-ui/
RUN pnpm install --frozen-lockfile
COPY scripts/clean-sdk-dist.mjs scripts/
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @jiange/web... build

FROM golang:1.27-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
COPY --from=web /src/apps/web/dist ./webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/jiange ./cmd/jiange

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
	&& adduser -D -H -u 1000 jiange

COPY --from=server /out/jiange /usr/local/bin/jiange
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/jiange /docker-entrypoint.sh \
	&& mkdir -p /data/blobs \
	&& chown -R jiange:jiange /data

USER jiange
ENV JIANGE_SECURE_COOKIES=true \
	JIANGE_AUTO_VERSION_EVERY=0 \
	PORT=8080
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
