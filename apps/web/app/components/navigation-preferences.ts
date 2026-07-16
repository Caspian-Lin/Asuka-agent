export const NAV_RAIL_COLLAPSED_STORAGE_KEY = "asuka-agent-nav-rail-collapsed";

export function parseNavRailCollapsed(value: string | null | undefined) {
  return value === "true";
}
