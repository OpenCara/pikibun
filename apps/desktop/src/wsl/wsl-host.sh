#!/bin/sh
# Starts Pikibun's connector host inside WSL2 for the Windows app (apps/desktop/src/main/wsl.ts), so its sessions run
# in WSL2's bubblewrap sandbox, as `pikibun connect` does there. The app runs
#   wsl.exe [--distribution NAME] --cd <the app's connector directory> --exec /bin/sh dist/wsl-host.sh BUILD [OPTIONS]
# and OPTIONS go to the host (desktop-host.ts) as they are. This script's stdin and stdout are the app's private
# channel (desktop-transport.ts, stdioTransport), so nothing here reads stdin or writes stdout before the host starts;
# what it says goes to stderr, and a line starting with "pikibun-setup: " is a problem the app shows the owner as is.
#
# The connector (the host's bundle and its production dependencies, the same tree the macOS app ships) is copied once
# per app build into ~/.local/share/pikibun/desktop, inside WSL2's own filesystem: the Windows drive is slow to load
# modules from and has no POSIX permissions. Pi's configuration and the connector's state are WSL2's, as for the CLI.
set -eu

setup() { printf 'pikibun-setup: %s\n' "$1" >&2; exit 78; }
# A problem the app knows how to fix (wsl.ts setupFixes) names its fix: pikibun-setup[CODE]: MESSAGE.
setup_fix() { printf 'pikibun-setup[%s]: %s\n' "$1" "$2" >&2; exit 78; }

build=${1:-}
case $build in
  '' | *[!0-9A-Za-z.+_-]*) setup "The app started its WSL2 host without a valid build name." ;;
esac
shift

source=$(pwd -P)
[ -f "$source/dist/desktop-host.mjs" ] || setup "The app's connector isn't at $source: reinstall Pikibun."

# Node.js 24 or newer: on PATH, or where a version manager installs it (nvm, fnm, Volta, mise, asdf), or what a login
# shell finds. Nothing that runs here may read the app's channel, hence </dev/null throughout.
major() { "$1" -e 'process.stdout.write(process.versions.node.split(".")[0])' </dev/null 2>/dev/null || printf 0; }
last() { tail -n 1; }
node=
for candidate in \
  "$(command -v node 2>/dev/null || true)" \
  "$(bash -c '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && command -v node' </dev/null 2>/dev/null | last || true)" \
  "$HOME/.local/share/fnm/aliases/default/bin/node" \
  "$HOME/.volta/bin/node" \
  "$HOME/.local/share/mise/shims/node" \
  "$HOME/.asdf/shims/node" \
  "$(bash -lc 'command -v node' </dev/null 2>/dev/null | last || true)" \
  /usr/local/bin/node /usr/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && [ "$(major "$candidate")" -ge 24 ] 2>/dev/null; then node=$candidate; break; fi
done
[ -n "$node" ] || setup_fix wsl-node "Node.js 24 or newer isn't installed in WSL2 (${WSL_DISTRO_NAME:-this distribution}). Install it there (for example with nvm: https://github.com/nvm-sh/nvm, then nvm install 24), then refresh."

base="$HOME/.local/share/pikibun/desktop"
target="$base/connector-$build"
if [ ! -f "$target/.complete" ]; then
  printf 'Copying Pikibun %s'"'"'s connector into WSL2 (%s); only its first start takes this long.\n' "$build" "$target" >&2
  mkdir -p "$base"
  staging="$base/.staging-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  # The web app is for Pikibun on this computer, which runs on Windows: the host doesn't need it.
  if ! (cd "$source" && tar -cf - --exclude=./dist/web .) </dev/null | (cd "$staging" && tar -xf -); then
    rm -rf "$staging"
    setup "Pikibun's connector could not be copied into WSL2 ($target)."
  fi
  : > "$staging/.complete"
  # Another of the app's hosts may have copied the same build meanwhile: keep the first, which may already be running.
  mv -T "$staging" "$target" 2>/dev/null || rm -rf "$staging"
  [ -f "$target/.complete" ] || setup "Pikibun's connector could not be copied into WSL2 ($target)."
  # Earlier builds' copies: the app runs one build at a time, and stopped those hosts before it updated.
  for old in "$base"/connector-*; do
    [ "$old" = "$target" ] || rm -rf "$old"
  done
fi

exec "$node" "$target/dist/desktop-host.mjs" --stdio "$@"
