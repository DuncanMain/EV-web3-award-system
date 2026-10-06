#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR=${DEPLOY_DIR:-/root/neverflat}
RELEASE_DIR=${RELEASE_DIR:?RELEASE_DIR must point to the staged release directory}
ENV_FILE=${ENV_FILE:-$DEPLOY_DIR/.env}
IMAGE_REFERENCE=${IMAGE_REFERENCE:?IMAGE_REFERENCE must be the built sha256 image reference}
GHCR_USER=${GHCR_USER:?GHCR_USER is required for the registry login}
GHCR_TOKEN=${GHCR_TOKEN:?GHCR_TOKEN is required for the registry login}
STARTUP_TIMEOUT_SECONDS=${STARTUP_TIMEOUT_SECONDS:-120}
STARTUP_INTERVAL_SECONDS=${STARTUP_INTERVAL_SECONDS:-5}

COMPOSE_FILE=$RELEASE_DIR/compose.production.yaml
PREFLIGHT=$RELEASE_DIR/scripts/preflight_production.py
ACCEPTANCE=$RELEASE_DIR/scripts/check_production_acceptance.py
LOCK_FILE=$DEPLOY_DIR/.deployment.lock

if [[ ! -f "$COMPOSE_FILE" || ! -f "$PREFLIGHT" || ! -f "$ACCEPTANCE" ]]; then
  echo "staged production release is incomplete" >&2
  exit 1
fi

if [[ -e "$DEPLOY_DIR/current" && ! -L "$DEPLOY_DIR/current" ]]; then
  echo "active release path is not a symlink; refusing to replace it" >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
# A blocking lock serializes rollouts and deliberately never cancels an active rollout.
flock 9

python3 "$PREFLIGHT" \
  --deploy-dir "$DEPLOY_DIR" \
  --env-file "$ENV_FILE" \
  --compose-file "$COMPOSE_FILE" \
  --image-reference "$IMAGE_REFERENCE"

COMPOSE_PROJECT_NAME=$(python3 - "$ENV_FILE" "$PREFLIGHT" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[2]).resolve().parent))
from preflight_production import parse_env_file
values = parse_env_file(sys.argv[1])
print(values["COMPOSE_PROJECT_NAME"])
PY
)

export IMAGE_REFERENCE
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
if ! docker network inspect shared-proxy >/dev/null 2>&1; then
  docker network create shared-proxy >/dev/null
fi

docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" pull app
docker compose \
  --project-name "$COMPOSE_PROJECT_NAME" \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" up -d --remove-orphans

running_image=$(docker inspect neverflat-app --format '{{.Config.Image}}')
if [[ "$running_image" != "$IMAGE_REFERENCE" ]]; then
  echo "running app image does not match the requested immutable image" >&2
  exit 1
fi

deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
accepted=false
while (( SECONDS < deadline )); do
  container_state=""
  if container_state=$(docker inspect neverflat-app --format '{{.State.Status}}|{{.State.Health.Status}}' 2>/dev/null) \
    && [[ "$container_state" == "running|healthy" ]] \
    && python3 "$ACCEPTANCE" --base-url http://127.0.0.1:3005 --env-file "$ENV_FILE" --quiet; then
    accepted=true
    break
  fi
  sleep "$STARTUP_INTERVAL_SECONDS"
done
if [[ "$accepted" != true ]]; then
  echo "post-start health/readiness did not pass within the bounded wait" >&2
  exit 1
fi

previous_record=$DEPLOY_DIR/.deployed-image
if [[ -f "$previous_record" ]]; then
  cp "$previous_record" "$DEPLOY_DIR/.previous-image"
  chmod 600 "$DEPLOY_DIR/.previous-image"
fi
record_tmp=$(mktemp "$DEPLOY_DIR/.deployed-image.XXXXXX")
printf '%s\n' "$IMAGE_REFERENCE" > "$record_tmp"
chmod 600 "$record_tmp"
mv "$record_tmp" "$previous_record"

ln -sfn "$RELEASE_DIR" "$DEPLOY_DIR/current"
echo "production rollout passed (image=$IMAGE_REFERENCE)"
