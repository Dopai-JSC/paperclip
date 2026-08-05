#!/usr/bin/env bash
set -euo pipefail

run_id="${KC10_RUN_ID:?KC10_RUN_ID is required}"
output_root="${KC10_OUTPUT_ROOT:-/opt/dopaios-kc10/evidence}"
output_dir="${output_root}/${run_id}"
display="${KC10_ORCA_DISPLAY:-:97}"

if [[ -e "${output_dir}" ]]; then
  echo "evidence directory already exists: ${output_dir}" >&2
  exit 2
fi
install -d -m 0700 "${output_dir}"

xvfb_pid=""
orca_pid=""
cleanup() {
  if [[ -n "${orca_pid}" ]]; then kill "${orca_pid}" 2>/dev/null || true; fi
  if [[ -n "${xvfb_pid}" ]]; then kill "${xvfb_pid}" 2>/dev/null || true; fi
}
trap cleanup EXIT

export DISPLAY="${display}"
export GDK_BACKEND=x11
export NO_AT_BRIDGE=0
export GTK_MODULES="gail:atk-bridge"

Xvfb "${display}" -screen 0 1440x900x24 -nolisten tcp >"${output_dir}/xvfb.log" 2>&1 &
xvfb_pid="$!"
sleep 2

orca --replace --enable speech --speech-system speechdispatcher \
  --debug-file "${output_dir}/orca-debug.log" \
  >"${output_dir}/orca.stdout.log" 2>"${output_dir}/orca.stderr.log" &
orca_pid="$!"
sleep 4

KC10_OUTPUT_DIR="${output_dir}" node scripts/kc10/orca-project-flow.mjs
sleep 2

speech_lines="$(grep -c "SPEECH OUTPUT" "${output_dir}/orca-debug.log" || true)"
control_speech_lines="$(grep "SPEECH OUTPUT" "${output_dir}/orca-debug.log" \
  | grep -Eic "Add Project|Project name|Create project|editable markdown" || true)"
printf 'run_id=%s\norca_speech_output_lines=%s\norca_control_speech_output_lines=%s\n' \
  "${run_id}" "${speech_lines}" "${control_speech_lines}"
if [[ "${control_speech_lines}" -lt 1 ]]; then
  echo "Orca debug log contains no speech evidence for a verified project-flow control" >&2
  exit 3
fi
