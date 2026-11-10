// What installs an update the app downloaded, kept free of NSH's modules so the repository's own tests run the
// scripts in a real shell (tests/app-update-scripts.test.ts).

const xmlText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function windowsInstallerArguments(log: string): string {
  return `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /RELAUNCH /LOG="${log}"`;
}

export function windowsUpdateTask(installer: string, log: string, user?: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo><Description>Installs the Pikibun update the app downloaded, then starts Pikibun again.</Description></RegistrationInfo>`,
    `  <Principals>`,
    `    <Principal id="Author">${user ? `<UserId>${xmlText(user)}</UserId>` : ""}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>false</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>true</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <WakeToRun>false</WakeToRun>`,
    `    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>`,
    `    <Priority>7</Priority>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec><Command>${xmlText(installer)}</Command><Arguments>${xmlText(windowsInstallerArguments(log))}</Arguments></Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

export function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  return bytes;
}

const DETACH = `detach() {
  if command -v setsid >/dev/null 2>&1; then setsid "$@" </dev/null >/dev/null 2>&1 &
  elif command -v perl >/dev/null 2>&1; then perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' "$@" </dev/null >/dev/null 2>&1 &
  else set -m; "$@" </dev/null >/dev/null 2>&1 &
  fi
  child=$!
  own=$(ps -o pgid= -p $$ | tr -d ' ')
  tries=0
  while [ "$tries" -lt 50 ]; do
    group=$(ps -o pgid= -p "$child" 2>/dev/null | tr -d ' ')
    [ -n "$group" ] && [ "$group" != "$own" ] && return 0
    [ -z "$group" ] && return 1
    tries=$((tries + 1))
    sleep 0.1
  done
  return 1
}
`;

export const MAC_INSTALL = `${DETACH}fail() { echo "$*" >&2; exit 1; }
app=$PPID
exe=$(ps -o comm= -p "$app" 2>/dev/null)
case $exe in
  /*/Contents/MacOS/*) ;;
  *) exe=$(lsof -a -p "$app" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | grep '/Contents/MacOS/' | head -n 1) ;;
esac
bundle=\${exe%%/Contents/MacOS/*}
case $bundle in
  /*.app) ;;
  *) fail "Pikibun's app wasn't found (\${exe:-no path})." ;;
esac
case $bundle in
  */AppTranslocation/*|/Volumes/*) fail "Pikibun is running from its download or its disk image: move it to Applications, open it from there, then update again." ;;
esac
parent=$(dirname "$bundle")
[ -w "$parent" ] || fail "$parent can't be written by $(id -un): install the update from its release page as an administrator."
mount=$(mktemp -d "\${TMPDIR:-/tmp}/pikibun-update.XXXXXX") || fail "No temporary folder to open the disk image in."
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$1" >/dev/null || { rmdir "$mount"; fail "The update's disk image didn't open."; }
staging="$parent/.Pikibun-update-$$.app"
rm -rf "$staging"
ditto "$mount/Pikibun.app" "$staging"
copied=$?
hdiutil detach "$mount" >/dev/null 2>&1 || hdiutil detach -force "$mount" >/dev/null 2>&1
rmdir "$mount" 2>/dev/null
{ [ "$copied" -eq 0 ] && [ -d "$staging/Contents/MacOS" ]; } || { rm -rf "$staging"; fail "The new Pikibun couldn't be copied next to $bundle."; }
old="$parent/.Pikibun-old-$$.app"
mv "$bundle" "$old" || { rm -rf "$staging"; fail "$bundle couldn't be replaced."; }
mv "$staging" "$bundle" || { mv "$old" "$bundle"; rm -rf "$staging"; fail "$bundle couldn't be replaced."; }
relaunch='while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf "$2"; exec open "$3"'
detach sh -c "$relaunch" pikibun-relaunch "$app" "$old" "$bundle" || echo "Pikibun doesn't start again by itself: open it once it has quit." >&2
echo "Installed in $bundle."
`;

export const LINUX_INSTALL = `${DETACH}fail() { echo "$*" >&2; exit 1; }
app=$PPID
exe=$(readlink "/proc/$app/exe") || fail "Pikibun's program wasn't found."
dir=\${exe%/*}
[ -d "$dir/nsh" ] || fail "Pikibun's folder wasn't found (\${exe})."
parent=\${dir%/*}
[ -n "$parent" ] || parent=/
[ -w "$parent" ] || fail "$parent can't be written by $(id -un): unpack the update from its release page yourself."
staging=$(mktemp -d "$parent/.Pikibun-update.XXXXXX") || fail "No room next to $dir to unpack the update."
{ tar -xzf "$1" -C "$staging" && [ -x "$staging/Pikibun/Pikibun" ]; } || { rm -rf "$staging"; fail "The new Pikibun couldn't be unpacked next to $dir."; }
old="$parent/.Pikibun-old-$$"
mv "$dir" "$old" || { rm -rf "$staging"; fail "$dir couldn't be replaced."; }
mv "$staging/Pikibun" "$dir" || { mv "$old" "$dir"; rm -rf "$staging"; fail "$dir couldn't be replaced."; }
rm -rf "$staging"
relaunch='while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf "$2"; cd "$HOME" 2>/dev/null || cd /; exec "$3"'
detach sh -c "$relaunch" pikibun-relaunch "$app" "$old" "$dir/Pikibun" || echo "Pikibun doesn't start again by itself: open it once it has quit." >&2
echo "Installed in $dir."
`;
