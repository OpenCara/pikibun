#!/usr/bin/env bash
# Runs on the deployment server, over Tailscale SSH from .github/workflows/deploy-server.yml:
#   ssh user@host bash -s -- IMAGE DIR < scripts/deploy-server.sh
# DIR holds the server's docker-compose.yml (whose pikibun service has `image: ${PIKIBUN_IMAGE...}`) and its .env.
# Pulls IMAGE, records it as PIKIBUN_IMAGE in .env (so a later `docker compose up -d` keeps it), recreates the pikibun
# service with it and waits for the container's health check. Migrations run when the new container starts, so a failed
# deploy is not rolled back automatically: an older server may not read the migrated database.
set -euo pipefail

image=${1:?image}
dir=${2:?directory}
timeout=${DEPLOY_HEALTH_TIMEOUT:-180}

cd "$dir"
[ -f .env ] || { echo "No .env in $(pwd): set up the server as docs/self-hosting.md's \"Docker\" says first." >&2; exit 1; }

echo "Pulling $image"
if ! docker pull --quiet "$image"; then
  # Docker sends a saved login for the registry with every pull, and the registry refuses an expired one even for a
  # public image. Deploys of other projects on the same server leave such logins behind (a job's GITHUB_TOKEN, valid
  # only while that job runs), so retry once without any saved credentials: the release image is public.
  echo "Pull refused; retrying without saved registry logins"
  anonymous=$(mktemp -d)
  trap 'rm -rf "$anonymous"' EXIT
  DOCKER_CONFIG="$anonymous" docker pull --quiet "$image"
fi

if grep -q '^PIKIBUN_IMAGE=' .env; then
  # --follow-symlinks keeps a symlinked .env a symlink, editing the file it points at.
  sed -i --follow-symlinks "s|^PIKIBUN_IMAGE=.*|PIKIBUN_IMAGE=$image|" .env
else
  printf '\nPIKIBUN_IMAGE=%s\n' "$image" >> .env
fi

# The compose file must take the image from PIKIBUN_IMAGE, or the service would keep running another one.
if ! docker compose config --images | grep -qxF "$image"; then
  echo "docker-compose.yml in $(pwd) does not run PIKIBUN_IMAGE: set the pikibun service's image to \${PIKIBUN_IMAGE:-pikibun}." >&2
  exit 1
fi

previous=$(docker compose ps -q pikibun 2>/dev/null | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null || true)
echo "Previous image: ${previous:-none}"

# Every failure after the container is recreated shows its logs and the image to go back to.
fail() {
  echo "$1" >&2
  echo "The pikibun service's latest logs:" >&2
  docker compose logs --tail 100 pikibun >&2 || true
  echo "To go back, deploy the previous image (${previous:-unknown}) once you know it reads the current database." >&2
  exit 1
}

docker compose up -d --no-build pikibun

# -a: a container that already exited (crashed at start) is listed too.
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
