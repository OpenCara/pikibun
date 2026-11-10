#!/usr/bin/env bash
set -euo pipefail

image=${1:?image}
dir=${2:?directory}
client=${3:-}
timeout=${DEPLOY_HEALTH_TIMEOUT:-180}

case "$client" in
  '') ;;
  nsh) static_dir=dist/client ;;
  *)
    echo "CLIENT must be nsh." >&2
    exit 1
    ;;
esac

cd "$dir"
[ -f .env ] || { echo "No .env in $(pwd): set up the server as docs/self-hosting.md's \"Docker\" says first." >&2; exit 1; }

echo "Pulling $image"
if ! docker pull --quiet "$image"; then
  echo "Pull refused; retrying without saved registry logins"
  anonymous=$(mktemp -d)
  trap 'rm -rf "$anonymous"' EXIT
  DOCKER_CONFIG="$anonymous" docker pull --quiet "$image"
fi

set_env() {
  local key=$1 value=$2
  if grep -q "^$key=" .env; then
    sed -i --follow-symlinks "s|^$key=.*|$key=$value|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}
unset_env() {
  sed -i --follow-symlinks "/^$1=/d" .env
}
set_env PIKIBUN_IMAGE "$image"
if [ -n "$client" ]; then
  unset_env STATIC_CLIENT
  set_env STATIC_DIR "$static_dir"
  unset_env PREVIEW_ORIGIN
  unset_env PREVIEW_STATIC_DIR
fi

if ! docker compose config --images | grep -qxF "$image"; then
  echo "docker-compose.yml in $(pwd) does not run PIKIBUN_IMAGE: set the pikibun service's image to \${PIKIBUN_IMAGE:-pikibun}." >&2
  exit 1
fi

previous=$(docker compose ps -q pikibun 2>/dev/null | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)
echo "Previous image: ${previous:-none}"

fail() {
  echo "$1" >&2
  echo "The pikibun service's latest logs:" >&2
  docker compose logs --tail 100 pikibun >&2 || true
  echo "To go back, deploy the previous image (${previous:-unknown}) once you know it reads the current database." >&2
  exit 1
}

docker compose up -d --no-build pikibun

container=$(docker compose ps -a -q pikibun)
[ -n "$container" ] || fail "No pikibun container after deploying $image."
want=$(docker image inspect -f '{{.Id}}' "$image")
have=$(docker inspect -f '{{.Image}}' "$container" || true)
[ "$want" = "$have" ] || fail "The pikibun container runs ${have:-no image}, not $image ($want)."

echo "Waiting up to ${timeout}s for the container to become healthy"
for _ in $(seq 1 "$timeout"); do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")
  case "$status" in
    healthy)
      echo "Deployed $image"
      exit 0
      ;;
    unhealthy|none)
      break
      ;;
  esac
  [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] || { status=exited; break; }
  sleep 1
done

fail "The pikibun container is ${status:-not healthy} after deploying $image."
