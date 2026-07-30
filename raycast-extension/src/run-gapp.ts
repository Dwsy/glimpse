/**
 * Quick no-view launcher: open the most recently run GAPP (isolated, no Pi).
 */
import { closeMainWindow, launchCommand, LaunchType, showHUD, showToast, Toast } from "@raycast/api";
import { catalogGapps, listGlobalRuns, runGapp } from "./lib/gapp";

export default async function Command() {
  try {
    const runs = await listGlobalRuns(1);
    if (runs[0]?.id) {
      await runGapp(runs[0].id, { cwd: runs[0].cwd || undefined });
      await closeMainWindow();
      await showHUD(`Opened ${runs[0].name || runs[0].id}`);
      return;
    }

    // Fallback: first app in catalog
    const sections = await catalogGapps({ includeArchived: false, includeDisabled: false });
    for (const s of sections) {
      if (s.apps[0]) {
        await runGapp(s.apps[0].id, { cwd: s.cwd || s.apps[0].cwd, scope: s.apps[0].scope });
        await closeMainWindow();
        await showHUD(`Opened ${s.apps[0].name}`);
        return;
      }
    }

    await showToast({
      style: Toast.Style.Failure,
      title: "No GAPP to open",
      message: "Use “Browse GAPPs” or create one in Pi first",
    });
    try {
      await launchCommand({ name: "browse-gapps", type: LaunchType.UserInitiated });
    } catch {
      // ignore if not registered yet
    }
  } catch (e) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Run GAPP failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
