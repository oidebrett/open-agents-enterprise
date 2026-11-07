# OAE Hermes image: the official Hermes image plus the Microsoft Teams SDK (Hermes's `teams` extra),
# so its bundled Teams platform plugin can run (docs/oae/teams.md). Nothing else changes.
ARG HERMES_IMAGE=docker.io/nousresearch/hermes-agent@sha256:adb7890916de63245523492be8f68f9d2095fecbec4e2a6dab7960381f0fc002
FROM ${HERMES_IMAGE}

# Exact versions (Hermes pyproject: teams = ["microsoft-teams-apps==2.1.1", ...]); pip is added for
# the install and removed again.
RUN /opt/hermes/.venv/bin/python -m ensurepip --upgrade >/dev/null \
    && /opt/hermes/.venv/bin/python -m pip install --no-cache-dir \
         "microsoft-teams-apps==2.1.1" "microsoft-teams-api==2.2.0" "microsoft-teams-cards==2.2.0" \
         "microsoft-teams-common==2.2.0" "dependency-injector==4.49.1" "pydantic-settings==2.16.2" \
    && /opt/hermes/.venv/bin/python -m pip uninstall -y pip >/dev/null \
    && /opt/hermes/.venv/bin/python -c "import importlib.util as u; assert u.find_spec('microsoft_teams.apps')"
