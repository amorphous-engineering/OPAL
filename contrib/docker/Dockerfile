# syntax=docker/dockerfile:1
#
# OPAL in a container: the release binary on a base with no shell and no package manager.
# The build context holds the binaries the release built, one per architecture, and an empty
# folder for the data volume:
#
#   amd64/opal   (opal-linux-x86_64)
#   arm64/opal   (opal-linux-arm64)
#   root/data/
#
# The release workflow lays the context out this way. To build one by hand:
#
#   mkdir -p ctx/amd64 ctx/root/data && cp opal-linux-x86_64 ctx/amd64/opal
#   docker build -f contrib/docker/Dockerfile -t opal:local ctx
#
# The binary needs only glibc. distroless/base also brings CA certificates and time zones.
FROM gcr.io/distroless/base-debian12:nonroot@sha256:7f0c72cd138b442ae0deeb69c08b1acf5525439ba251a49ad93c320a061567e5

ARG TARGETARCH
COPY --chmod=0555 ${TARGETARCH}/opal /opal
# A named volume starts as a copy of this folder, so it belongs to the default user, owner-only.
# A bind mount keeps its own owner: give the host folder to the user the container runs as.
# Copied from a parent folder because --chmod sets what is copied, not the folder it lands in.
COPY --chown=65532:65532 --chmod=0700 root/ /

ENV OPAL_DATA_DIR=/data \
    OPAL_HOST=0.0.0.0 \
    OPAL_PORT=8080

# distroless's nonroot user. Override with `user:` to match the owner of a bind-mounted folder.
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8080

# `serve`, not the supervisor: the supervisor replaces its own binary to update, and an image is
# updated by pulling a new one. There is no shell for a HEALTHCHECK; GET /api/health from outside.
ENTRYPOINT ["/opal"]
CMD ["serve"]
