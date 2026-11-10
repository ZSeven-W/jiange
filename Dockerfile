# Multi-stage build: compile the web frontend, embed it into the Go server,
# and ship a static binary. Nothing is read from the repo at runtime.
FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/collab/package.json packages/collab/
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @jiange/web build

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
ENV JIANGE_BLOB_DIR=/data/blobs \
	JIANGE_SECURE_COOKIES=true \
	JIANGE_AUTO_VERSION_EVERY=0 \
	PORT=8080
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
