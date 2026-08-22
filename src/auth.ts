import { config } from "./config.ts";

export function isAllowed(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return config.allowedIds.includes(userId);
}
