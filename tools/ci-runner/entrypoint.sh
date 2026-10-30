#!/bin/sh
# Root for exactly three things, then gone: read the one-job config, close off the LAN and the
# host, and drop every privilege. A job can only ever run as uid 10001 with no capabilities.
set -eu

IFS= read -r JIT_CONFIG

# Web only, and never a private address: no host ports, no compose stack, no LAN.
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  iptables -A OUTPUT -d "$net" -j REJECT
done
iptables -A OUTPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -j REJECT

# The container ends with the first of these three. The launcher holds stdin open for the
# container's whole life, so if it dies, however it dies, `cat` ends and takes the runner with it.
# The sleep is a backstop, past the launcher's own 80-minute limit.
exec setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all \
  bash -c '
    ./run.sh --jitconfig "$1" </dev/null &
    cat >/dev/null &
    sleep 5400 &
    wait -n
  ' bash "$JIT_CONFIG"
