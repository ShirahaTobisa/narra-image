export function imageDownloadTimestamp() {
  const date = new Date(Date.now());
  return [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0")).join("-");
}
