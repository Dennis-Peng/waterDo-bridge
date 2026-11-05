#!/usr/bin/env bash
# Preparation only. Run manually from an ordinary host terminal, never a sandbox.
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
unset NODE_OPTIONS NODE_PATH

fail() { printf '%s\n' "$1" >&2; exit 1; }
trap 'printf "%s\n" "systemd preparation failed; no credential content was read." >&2' ERR

# Validate the original spelling BEFORE realpath; normalization must not hide a
# symlink, ../ component, whitespace, systemd specifier or replacement metacharacter.
safe_path() { [[ $1 =~ ^/[A-Za-z0-9_./-]+$ ]]; }
canonical_path() {
  local path=$1 component cursor= remainder
  safe_path "$path" || return 1
  [[ $path != */ && $path != *//* && $path != */./* && $path != */../* && $path != */. && $path != */.. ]] || return 1
  remainder=${path#/}
  while [[ -n $remainder ]]; do
    component=${remainder%%/*}
    cursor+=/$component
    [[ ! -L $cursor ]] || return 1
    if [[ $remainder == */* ]]; then remainder=${remainder#*/}; else remainder=; fi
  done
  [[ $(realpath -e -- "$path") == "$path" ]]
}

[[ $# -eq 0 ]] || fail 'This installer does not accept arguments or command overrides.'
[[ $EUID -eq 0 ]] || fail 'Run manually: sudo bash deploy/install-systemd.sh'
[[ ${SUDO_USER:-} =~ ^[A-Za-z_][A-Za-z0-9_-]*$ && ${SUDO_USER:-} != root ]] || fail 'Run sudo from the non-root account that owns this checkout.'
readonly service_user=$SUDO_USER
service_uid=$(id -u -- "$service_user") || fail 'Cannot resolve the service user.'
service_gid=$(id -g -- "$service_user") || fail 'Cannot resolve the primary group.'
service_group=$(id -gn -- "$service_user") || fail 'Cannot resolve the primary group name.'
[[ $service_uid =~ ^[1-9][0-9]*$ && $service_gid =~ ^[1-9][0-9]*$ ]] || fail 'Service user and primary group must be non-root.'
[[ $service_group =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail 'Unsafe service group name.'
[[ $(id -un -- "$service_user") == "$service_user" ]] || fail 'Ambiguous service user name.'
[[ ${SUDO_UID:-} == "$service_uid" && ${SUDO_GID:-} == "$service_gid" ]] || fail 'sudo identity does not match the service account.'
readonly service_uid service_gid service_group
[[ -x /usr/bin/node && -x /usr/bin/systemd-creds && -x /usr/bin/getfacl && -x /usr/bin/systemd-analyze ]] || fail 'Require /usr/bin/node, systemd-creds, getfacl (acl package), and systemd-analyze.'
[[ $(/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/node -p 'Number(process.versions.node.split(".")[0]) >= 22') == true ]] || fail 'Node.js >=22 at /usr/bin/node is required.'

# Derive the checkout from this script, not the caller's cwd or an env override.
script_path=${BASH_SOURCE[0]}
if [[ $script_path != /* ]]; then script_path=$PWD/$script_path; fi
canonical_path "$script_path" || fail 'Installer path must be canonical, symlink-free safe ASCII.'
[[ -f $script_path && $script_path == */deploy/install-systemd.sh ]] || fail 'Unexpected installer location.'
readonly project=${script_path%/deploy/install-systemd.sh}
readonly source_unit=$project/deploy/waterdo-bridge.service
readonly target_unit=/etc/systemd/system/waterdo-bridge.service
readonly credstore=/etc/credstore.encrypted
canonical_path "$project" && [[ -d $project && $(stat -c '%u' -- "$project") == "$service_uid" ]] || fail 'Service user must own the canonical checkout directory.'
canonical_path "$source_unit" && [[ -f $source_unit ]] || fail 'Unexpected source unit path.'
canonical_path "$project/src/cli.mjs" && [[ -f $project/src/cli.mjs ]] || fail 'Missing or unsafe project CLI.'
canonical_path "$project/.private" && [[ -d $project/.private && $(stat -c '%u:%a' -- "$project/.private") == "$service_uid:700" ]] || fail 'Configure the local vault as the service user first; .private must be owned by that user with mode 0700.'
canonical_path /etc/systemd/system || fail 'Unexpected system unit directory.'
[[ ! -L $target_unit && ( ! -e $target_unit || -f $target_unit ) ]] || fail 'Refusing a symlink or nonregular target unit.'
canonical_path /etc || fail 'Unexpected credential store parent.'
[[ ! -L $credstore ]] || fail 'Refusing a symlink credential store.'
if [[ -e $credstore ]]; then
  canonical_path "$credstore" && [[ -d $credstore && $(stat -c '%u:%a' -- "$credstore") == 0:700 ]] || fail 'Existing credential store must be canonical, root-owned mode 0700.'
fi

# Fixed /tmp prefix, no TMPDIR override. Only this root-owned 0700 directory and
# its one generated regular file may be removed, after rechecking absolute paths.
temp_dir=
temp_unit=
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n $temp_dir ]]; then
    if [[ ! $temp_dir =~ ^/tmp/waterdo-systemd-install\.[A-Za-z0-9]{10}$ ]] || ! canonical_path "$temp_dir" || [[ ! -d $temp_dir || $(stat -c '%u:%a' -- "$temp_dir") != 0:700 ]]; then
      printf '%s\n' 'Refusing cleanup: temporary directory validation failed.' >&2
      exit 1
    fi
    if [[ -n $temp_unit ]]; then
      [[ $temp_unit == "$temp_dir/waterdo-bridge.service" ]] && canonical_path "$temp_unit" && [[ -f $temp_unit && $(stat -c '%u:%a:%h' -- "$temp_unit") == 0:600:1 ]] || { printf '%s\n' 'Refusing cleanup: temporary unit validation failed.' >&2; exit 1; }
      rm -- "${temp_unit:?}"
    fi
    rmdir -- "${temp_dir:?}"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
canonical_path /tmp && [[ -d /tmp && $(stat -c '%u:%a' -- /tmp) == 0:1777 ]] || fail 'Expected canonical root-owned /tmp with mode 1777.'
temp_dir=$(mktemp -d /tmp/waterdo-systemd-install.XXXXXXXXXX)
[[ $temp_dir =~ ^/tmp/waterdo-systemd-install\.[A-Za-z0-9]{10}$ ]] && canonical_path "$temp_dir" && [[ -d $temp_dir && $(stat -c '%u:%a' -- "$temp_dir") == 0:700 ]] || fail 'Unsafe temporary directory.'
temp_unit=$temp_dir/waterdo-bridge.service
# The allowlists above exclude sed delimiters, ampersands, backslashes and '%'.
sed -e "s|@SERVICE_USER@|$service_user|g" \
    -e "s|@SERVICE_GROUP@|$service_group|g" \
    -e "s|@PROJECT_DIR@|$project|g" -- "$source_unit" > "$temp_unit"
canonical_path "$temp_unit" && [[ -f $temp_unit && $(stat -c '%u:%a:%h' -- "$temp_unit") == 0:600:1 ]] || fail 'Unsafe generated unit.'
/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C /usr/bin/systemd-analyze verify "$temp_unit"

# No credential reads/writes, no .private changes, no start. Recheck destination
# metadata before installing the rendered unit; never install the raw template.
canonical_path /etc/systemd/system || fail 'System unit directory changed.'
[[ ! -L $target_unit && ( ! -e $target_unit || -f $target_unit ) ]] || fail 'Target unit changed.'
if [[ ! -e $credstore && ! -L $credstore ]]; then mkdir --mode=0700 -- "$credstore"; fi
canonical_path "$credstore" && [[ -d $credstore && $(stat -c '%u:%a' -- "$credstore") == 0:700 ]] || fail 'Credential store changed.'
install --owner=root --group=root --mode=0644 -- "$temp_unit" "$target_unit"
systemctl daemon-reload
systemctl enable waterdo-bridge.service
printf '%s\n' \
  'Prepared and enabled waterdo-bridge.service; it has NOT been started.' \
  'Before rebooting: as the checkout owner, run sudo -v, then /usr/bin/node src/cli.mjs service-enroll in this checkout.' \
  'Only after successful enrollment run: sudo systemctl enable --now waterdo-bridge.service'
