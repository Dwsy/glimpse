import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { hostCatalog, hostWindow } from "./lib/host";

export default async function Command() {
  try {
    const { live, leases } = await hostCatalog();
    if (live.length === 0) {
      await showHUD("No live GAPP windows");
      return;
    }
    // Proxy for "active": the most recently opened live window.
    const openedAt = new Map(leases.map((lease) => [lease.appId, lease.openedAt]));
    const target = [...live].sort(
      (a, b) => Date.parse(openedAt.get(b.appId) || "") - Date.parse(openedAt.get(a.appId) || ""),
    )[0];
    await hostWindow(target.appId, "focus");
    await closeMainWindow();
    await showHUD(`Focused: ${target.appId}`);
  } catch (e) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Focus failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
