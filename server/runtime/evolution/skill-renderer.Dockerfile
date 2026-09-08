FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
# Dependency preparation only. Execution must reference the resulting immutable image digest.
# Build context contains this Dockerfile and administrator-provided fonts, never business data.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-docx python3-fitz libreoffice-writer fontconfig fonts-noto-cjk \
    && dpkg-query -W > /opt/evolution-renderer-packages.txt \
    && rm -rf /var/lib/apt/lists/*
COPY fonts/ /usr/local/share/fonts/evolution/
RUN fc-cache -f && chmod -R a-w /usr/local/share/fonts/evolution /opt/evolution-renderer-packages.txt
ENV HOME=/workspace PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
WORKDIR /workspace
