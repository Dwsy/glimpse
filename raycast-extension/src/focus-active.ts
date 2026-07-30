import { closeMainWindow, showHUD, showToast, Toast } from "@raycast/api";
import { focusWindow, isHostRunning, listWindows } from "./lib/control";

export default async function Command() {
  if (!isHostRunning()) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Glimpse host not running",
      message: "Open a Glimpse window first",
    });
    return;
  }

  try {
    const { windows } = await listWindows();
    if (windows.length === 0) {
      await showHUD("No Glimpse windows");
      return;
    }
    const target = windows.find((w) => w.active) ?? windows[0];
    await focusWindow(target.id);
    await closeMainWindow();
    await showHUD(`Focused: ${target.title}`);
  } catch (e) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Focus failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
