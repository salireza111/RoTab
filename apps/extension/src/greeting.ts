/** Use the same browser-local time as the new-tab clock. */
export function getLocalGreeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5 || hour >= 22) return "Good night";
  if (hour >= 18) return "Good evening";
  return hour < 12 ? "Good morning" : "Good afternoon";
}
