FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /opt/evolution-dependencies
# Build context contains only these two reviewed dependency manifests and this Dockerfile.
# Dependency scripts are deliberately excluded from preparation; no project .env or source is copied.
COPY package.json package-lock.json ./
RUN npm ci --registry="$NPM_REGISTRY" --ignore-scripts --no-audit --no-fund && npm cache clean --force
USER 1000:1000
WORKDIR /workspace
