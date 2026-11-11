# PII masker: the gateway's upstream. Built from oidebrett/inference-router (router/) at the
# pinned MASKER_REF, on a pinned Python base. Same layout as router/anthropic_masker/Dockerfile.
ARG PYTHON_IMAGE
FROM ${PYTHON_IMAGE}
COPY anthropic_masker/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && useradd -u 10002 -M masker
WORKDIR /app
COPY pii_router/__init__.py pii_router/detectors.py pii_router/mask.py ./pii_router/
COPY inference_router/__init__.py inference_router/config.py inference_router/detection.py ./inference_router/
COPY anthropic_masker/__init__.py anthropic_masker/app.py ./anthropic_masker/
RUN chmod -R a+rX /app
USER 10002
EXPOSE 8080
CMD ["uvicorn", "--factory", "anthropic_masker.app:app_factory", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
