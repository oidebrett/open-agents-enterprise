#!/bin/sh
# Start charon, load /etc/swanctl once it answers, then stay in the foreground with it.
set -e
/usr/lib/strongswan/charon &
pid=$!
for i in $(seq 30); do swanctl --stats >/dev/null 2>&1 && break; sleep 1; done
swanctl --load-all --noprompt >/dev/null || true
wait $pid
