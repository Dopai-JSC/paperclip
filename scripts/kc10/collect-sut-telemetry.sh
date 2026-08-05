#!/usr/bin/env bash
set -euo pipefail

run_id="${KC10_RUN_ID:?KC10_RUN_ID is required}"
duration_seconds="${KC10_TELEMETRY_SECONDS:-1_850}"
output_root="${KC10_OUTPUT_ROOT:-/opt/dopaios-kc10/evidence}"
output_dir="${output_root}/${run_id}"

if [[ -e "${output_dir}" ]]; then
  echo "evidence directory already exists: ${output_dir}" >&2
  exit 2
fi
if ! [[ "${duration_seconds}" =~ ^[0-9]+$ ]] || [[ "${duration_seconds}" -lt 1 ]]; then
  echo "KC10_TELEMETRY_SECONDS must be a positive integer" >&2
  exit 2
fi

install -d -m 0700 "${output_dir}"
app_pid="$(systemctl show dopaios-kc10-sut.service -p MainPID --value)"
if [[ -z "${app_pid}" || "${app_pid}" == "0" ]]; then
  echo "dopaios-kc10-sut.service has no running MainPID" >&2
  exit 3
fi

printf 'timestamp_utc,max_connections,total_connections,active_connections,idle_connections,oldest_transaction_ms\n' \
  >"${output_dir}/dbstats.csv"

vmstat -w -t 1 >"${output_dir}/vmstat.log" 2>"${output_dir}/vmstat.stderr" &
vmstat_pid="$!"
pidstat -H -p "${app_pid}" -u -r -d 1 >"${output_dir}/pidstat.log" 2>"${output_dir}/pidstat.stderr" &
pidstat_pid="$!"
iostat -t -y -x 1 >"${output_dir}/iostat.log" 2>"${output_dir}/iostat.stderr" &
iostat_pid="$!"

cleanup() {
  kill "${vmstat_pid}" "${pidstat_pid}" "${iostat_pid}" 2>/dev/null || true
  wait "${vmstat_pid}" "${pidstat_pid}" "${iostat_pid}" 2>/dev/null || true
}
trap cleanup EXIT

deadline=$((SECONDS + duration_seconds))
while (( SECONDS < deadline )); do
  sudo -u postgres psql -X -d dopaios_kc10 -AtF, -c \
    "SELECT clock_timestamp(), current_setting('max_connections')::int, count(*), count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state = 'idle'), COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min(xact_start))) * 1000, 0) FROM pg_stat_activity;" \
    >>"${output_dir}/dbstats.csv" 2>>"${output_dir}/dbstats.stderr"
  sleep 1
done
