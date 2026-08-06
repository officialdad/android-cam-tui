#!/bin/bash
# Fake scrcpy for runner tests. MODE: die-evicted | run-forever
echo "[server] INFO: Using camera '0'" >&2
case "${MODE:-die-evicted}" in
  die-evicted)
    sleep 0.2
    echo "[server] WARN: Camera disconnected" >&2
    echo "WARN: Device disconnected" >&2
    exit 2
    ;;
  run-forever)
    sleep 600
    ;;
esac
