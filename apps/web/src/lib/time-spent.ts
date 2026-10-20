/** Time someone spent somewhere, in words: "under a minute", "45 min", "3 h 20 min". */
export function timeSpent(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 && hours < 10 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
