import { expect, it } from "vitest";
import { getLocalGreeting } from "./greeting";

it.each([
  [0, 0, "Good night"],
  [1, 0, "Good night"],
  [4, 59, "Good night"],
  [5, 0, "Good morning"],
  [11, 59, "Good morning"],
  [12, 0, "Good afternoon"],
  [17, 59, "Good afternoon"],
  [18, 0, "Good evening"],
  [21, 59, "Good evening"],
  [22, 0, "Good night"],
  [23, 59, "Good night"],
] as const)(
  "uses the browser-local greeting at %i:%i",
  (hour, minute, expected) => {
    // The local constructor mirrors getHours()/toLocaleTimeString() in the UI.
    const browserLocalTime = new Date(2026, 9, 8, hour, minute);
    expect(getLocalGreeting(browserLocalTime)).toBe(expected);
  },
);

it("keeps the overnight greeting when the date changes at midnight", () => {
  const beforeMidnight = new Date(2026, 9, 8, 23, 59, 59);
  const afterMidnight = new Date(beforeMidnight.getTime() + 1000);
  expect(getLocalGreeting(beforeMidnight)).toBe("Good night");
  expect(getLocalGreeting(afterMidnight)).toBe("Good night");
});
