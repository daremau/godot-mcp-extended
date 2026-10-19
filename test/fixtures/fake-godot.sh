#!/usr/bin/env bash
# Fake Godot CLI for the conformance suite (spec 05): deterministic, no engine needed.
for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "Godot Engine v4.7.stable.mono.fake-conformance"
    exit 0
  fi
done
echo "Godot Engine v4.7.stable.mono.fake-conformance"
echo "[SIGNAL] {\"t\": 1, \"kind\": \"ready\", \"data\": {\"fake\": true}}"
exit 0
