# One-job GitHub Actions runner for RouteFlow's no-secret CI jobs (Verify, Control).
# Design and threat model: docs/runbooks/self-hosted-runner-trial.md.
# Nothing here holds a credential. tools/ci-runner/launch-once.mjs hands in a one-job config on stdin.
FROM ubuntu:24.04

ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git iptables jq python3 unzip util-linux xz-utils zip \
  && useradd --uid 10001 --create-home --shell /bin/bash runner \
  && mkdir /home/runner/actions-runner \
  && cd /home/runner/actions-runner \
  && curl -fsSLo runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
  && echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c - \
  && tar xzf runner.tar.gz \
  && rm runner.tar.gz \
  && ./bin/installdependencies.sh \
  && chown -R runner:runner /home/runner \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh

ENV LANG=C.UTF-8 HOME=/home/runner
WORKDIR /home/runner/actions-runner
ENTRYPOINT ["/entrypoint.sh"]
