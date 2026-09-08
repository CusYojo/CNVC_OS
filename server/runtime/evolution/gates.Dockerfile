ARG EVOLUTION_DEPENDENCY_IMAGE
FROM ${EVOLUTION_DEPENDENCY_IMAGE}
USER 0:0
COPY gates /opt/evolution-gates
RUN ln -s /opt/evolution-dependencies/node_modules /opt/evolution-gates/node_modules && chmod -R a-w /opt/evolution-gates
USER 1000:1000
WORKDIR /workspace
