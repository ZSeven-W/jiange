# 构建前端 → 拷贝进 Go embed → 单二进制
FROM node:20-alpine AS web
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/collab/package.json packages/collab/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @jiange/web build

FROM golang:1.27-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
RUN rm -rf webui/dist && mkdir -p webui/dist
COPY --from=web /app/apps/web/dist webui/dist
RUN CGO_ENABLED=0 go build -o /jiange ./cmd/jiange

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=server /jiange /usr/local/bin/jiange
ENV JIANGE_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["jiange"]
