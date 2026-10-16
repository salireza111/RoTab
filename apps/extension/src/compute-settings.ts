// Browsers expose logical processors, not physical-core affinity or CPU load.
export function availableCores() {
  const reported =
    typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency;
  return Number.isFinite(reported) && reported >= 1
    ? Math.min(256, Math.floor(reported))
    : 1;
}
export function defaultWorkerCount() {
  return 1;
}
export function validWorkerCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(availableCores(), value))
    : defaultWorkerCount();
}
