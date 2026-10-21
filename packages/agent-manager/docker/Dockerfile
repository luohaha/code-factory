FROM node:22-bookworm

# Linux tools take precedence over executables in the mounted host home.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git gh libnss-wrapper openssh-client python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN ln -s /usr/lib/*/libnss_wrapper.so /usr/local/lib/libnss_wrapper.so
ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN npm install --global @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

WORKDIR /opt/code-factory
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; \
    else npm install --omit=dev --ignore-scripts --package-lock=false; fi
COPY dist ./dist
RUN chmod +x dist/code-factory-cli-main.js \
    && ln -s /opt/code-factory/dist/code-factory-cli-main.js /usr/local/bin/code-factory-cli
CMD ["bash"]
