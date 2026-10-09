#!/bin/sh
set -eu

secret_file=/run/secrets/turn_secret
config_file=/tmp/turnserver.runtime.conf

if [ ! -r "$secret_file" ]; then
  echo "coturn: mounted TURN secret is unavailable" >&2
  exit 1
fi
if [ -z "${TURN_REALM:-}" ] || [ -z "${TURN_EXTERNAL_IP:-}" ]; then
  echo "coturn: TURN_REALM and TURN_EXTERNAL_IP are required" >&2
  exit 1
fi

umask 077
cp /etc/coturn/turnserver.conf "$config_file"
chmod 600 "$config_file"
printf 'realm=%s\nexternal-ip=%s\n' "$TURN_REALM" "$TURN_EXTERNAL_IP" >> "$config_file"
secret=$(cat "$secret_file")
if [ -z "$secret" ]; then
  echo "coturn: mounted TURN secret is empty" >&2
  rm -f "$config_file"
  exit 1
fi
printf 'static-auth-secret=%s\n' "$secret" >> "$config_file"
unset secret
chmod 600 "$config_file"
exec turnserver -c "$config_file"
