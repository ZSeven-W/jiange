# Deploy image for Suga, Render, and similar platforms.
# Copies the committed static linux/amd64 binary; no compile, no Node.
# The Free runtime is 0.1 vCPU / 256 MiB, so the frontend is already
# embedded in bin/jiange (CGO_ENABLED=0).
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
	&& adduser -D -H -u 1000 jiange

COPY bin/jiange /usr/local/bin/jiange
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
