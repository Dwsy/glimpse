import { useCallback, useState } from "react";
import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  showToast,
  Toast,
  closeMainWindow,
  popToRoot,
} from "@raycast/api";
import { useAsync } from "./lib/use-async";
import { hostCatalog, hostWindow, type HostLiveApp } from "./lib/host";
import { catalogGapps, projectLabel } from "./lib/gapp";

type LiveRow = HostLiveApp & { name: string; project: string };

function subtitleFor(row: LiveRow): string {
  const bits = [row.project];
  bits.push(row.source === "pi-bridge" ? `held by ${row.sessionId}` : "host window");
  return bits.join(" · ");
}

export default function Command() {
  const [search, setSearch] = useState("");
  const { data, isLoading, error, revalidate } = useAsync(async (): Promise<LiveRow[]> => {
    const [catalog, host] = await Promise.all([
      catalogGapps({ includeArchived: true, includeDisabled: true }).catch(() => []),
      hostCatalog(),
    ]);
    const metaById = new Map(catalog.flatMap((section) => section.apps).map((app) => [app.id, app]));
    return host.live.map((live) => {
      const meta = metaById.get(live.appId);
      return {
        ...live,
        name: meta?.name || live.appId,
        project: projectLabel(live.cwd || meta?.cwd),
      };
    });
  });

  const rows = (data ?? []).filter((row) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      row.name.toLowerCase().includes(q) ||
      row.appId.toLowerCase().includes(q) ||
      row.project.toLowerCase().includes(q) ||
      row.sessionId.toLowerCase().includes(q)
    );
  });

  const onFocus = useCallback(async (row: LiveRow) => {
    try {
      await hostWindow(row.appId, "focus");
      await closeMainWindow({ clearRootSearch: true });
      await popToRoot({ clearSearchBar: true });
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to focus window",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const onClose = useCallback(
    async (row: LiveRow) => {
      try {
        await hostWindow(row.appId, "close");
        await showToast({ style: Toast.Style.Success, title: `Closed ${row.name}` });
        revalidate();
      } catch (e) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to close window",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [revalidate],
  );

  if (error) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not talk to the GAPP host"
          description={error.message}
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter live GAPP windows…"
      onSearchTextChange={setSearch}
      throttle
    >
      {rows.length === 0 ? (
        <List.EmptyView
          icon={Icon.Window}
          title="No live GAPP windows"
          description="Open one with “Browse GAPPs”, or from Pi / the gapp CLI."
        />
      ) : (
        rows.map((row) => (
          <List.Item
            key={row.appId}
            title={row.name}
            subtitle={subtitleFor(row)}
            icon={{ source: Icon.Window, tintColor: Color.Green }}
            accessories={[
              ...(row.instances === "single" ? [{ tag: { value: "single", color: Color.Orange } }] : []),
              ...(row.source === "pi-bridge" ? [{ tag: { value: "pi", color: Color.Blue } }] : []),
            ]}
            actions={
              <ActionPanel>
                <Action title="Focus Window" icon={Icon.ArrowRight} onAction={() => onFocus(row)} />
                <Action
                  title="Close Window"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => onClose(row)}
                />
                <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={() => revalidate()} />
                <Action.CopyToClipboard title="Copy App ID" content={row.appId} />
                <Action.CopyToClipboard title="Copy Session ID" content={row.sessionId} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
