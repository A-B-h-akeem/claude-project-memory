#!/usr/bin/env bash
# Runs every automated test: hook tests (bash) and rlog.js tests (node --test).
# RL_SKIP_BIG=1 skips the 200 MB transcript test (T26).
HERE=$(cd "$(dirname "$0")" && pwd)
status=0
bash "$HERE/hooks.test.sh" || status=1
echo "rlog.js"
node --test "$HERE/rlog.test.js" || status=1
[ $status -eq 0 ] && echo "ALL PASSED" || echo "SOME TESTS FAILED"
exit $status
