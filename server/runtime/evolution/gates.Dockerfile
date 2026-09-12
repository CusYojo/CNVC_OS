ARG EVOLUTION_DEPENDENCY_IMAGE
FROM ${EVOLUTION_DEPENDENCY_IMAGE}
USER 0:0
COPY server/tests/projectDeletionAuthorization.test.ts /opt/evolution-gates/projectDeletionAuthorization.test.ts
COPY server/tests/leadEnrichmentContract.test.ts /opt/evolution-gates/leadEnrichmentContract.test.ts
COPY server/tests/leadPresentation.test.ts /opt/evolution-gates/leadPresentation.test.ts
RUN ln -s /opt/evolution-dependencies/node_modules /opt/evolution-gates/node_modules \
    && ln -s /workspace/source/server/src /opt/src \
    && ln -s /workspace/source/src /src \
    && chmod -R a-w /opt/evolution-gates
USER 1000:1000
WORKDIR /workspace
