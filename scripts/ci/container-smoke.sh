#!/usr/bin/env bash
set -euo pipefail

image=${1:-apature-judgment-engine:ci}
engine_container=apature-judgment-engine-smoke
capture_container=apature-capture-readiness-stub

cleanup() {
  docker rm --force "$engine_container" "$capture_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

reported=$(docker run --rm --entrypoint node "$image" --version)
if [[ $reported != v24.* ]]; then
  echo "expected $image to report Node 24, got $reported" >&2
  exit 1
fi

reported_distro=$(docker run --rm --entrypoint sh "$image" -c '. /etc/os-release; printf "%s %s" "$ID" "$VERSION_ID"')
if [[ $reported_distro != "debian 13" ]]; then
  echo "expected $image to use supported Debian 13, got $reported_distro" >&2
  exit 1
fi
docker run --rm --entrypoint sh "$image" -c \
  'dpkg --compare-versions "$(dpkg-query -W liblzma5 | cut -f2)" ge "5.8.1-1+deb13u1"'

release_command='  release_command = "node node_modules/@apatureai/verdict-db/dist/cli/migrate.js"'
if ! grep --fixed-strings --line-regexp "$release_command" fly.toml >/dev/null; then
  echo "fly.toml release command does not match the package-scoped runtime image" >&2
  exit 1
fi
docker run --rm --entrypoint test "$image" -f node_modules/@apatureai/verdict-db/dist/cli/migrate.js

# Throwaway CI-local values only: the DB URL points at the ephemeral
# postgres:17-alpine service container defined in .github/workflows/ci.yml, and
# every "smoke-*" value below is a literal placeholder. No real credentials.
database_url=postgresql://postgres:postgres@127.0.0.1:5432/postgres
docker run --rm --network host \
  --env DATABASE_URL="$database_url" \
  --entrypoint node \
  "$image" node_modules/@apatureai/verdict-db/dist/cli/migrate.js

docker run --detach --name "$capture_container" --network host \
  --entrypoint node \
  "$image" --input-type=module --eval \
  'import {createServer} from "node:http"; createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end("{\"status\":\"ready\"}")}).listen(18081,"127.0.0.1")' \
  >/dev/null

docker run --detach --name "$engine_container" --network host \
  --env PORT=18080 \
  --env DATABASE_URL="$database_url" \
  --env ENGINE_HMAC_SECRET=smoke-engine-hmac \
  --env MODEL_API_KEY=smoke-model-key \
  --env MODEL_BASE_URL=http://127.0.0.1:18082/v1 \
  --env CAPTURE_ENDPOINT=http://127.0.0.1:18081 \
  --env CAPTURE_API_TOKEN=smoke-capture-token \
  --env OBJECT_STORE_BUCKET=smoke-artifacts \
  --env OBJECT_STORE_REGION=us-east-1 \
  --env OBJECT_STORE_ACCESS_KEY_ID=smoke-access-key \
  --env OBJECT_STORE_SECRET_ACCESS_KEY=smoke-secret-key \
  --env WORKER_POLL_MS=100 \
  "$image" >/dev/null

for _ in {1..60}; do
  if curl --fail --silent --show-error http://127.0.0.1:18080/livez >/dev/null; then
    break
  fi
  if [[ $(docker inspect --format '{{.State.Running}}' "$engine_container") != true ]]; then
    docker logs "$engine_container" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error http://127.0.0.1:18080/livez \
  | grep --fixed-strings '"status":"live"' >/dev/null
readiness=
for _ in {1..30}; do
  if readiness=$(curl --fail --silent --show-error http://127.0.0.1:18080/readyz 2>/dev/null); then
    break
  fi
  sleep 1
done
if [[ -z $readiness ]]; then
  docker logs "$engine_container" >&2
  echo "production readiness did not become healthy" >&2
  exit 1
fi
grep --fixed-strings '"status":"ready"' <<<"$readiness" >/dev/null
grep --fixed-strings '"database":true' <<<"$readiness" >/dev/null
grep --fixed-strings '"capture":true' <<<"$readiness" >/dev/null
grep --fixed-strings '"worker":true' <<<"$readiness" >/dev/null

docker stop --time 15 "$engine_container" >/dev/null
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$engine_container")
if [[ $exit_code != 0 ]]; then
  docker logs "$engine_container" >&2
  echo "expected graceful exit code 0, got $exit_code" >&2
  exit 1
fi
