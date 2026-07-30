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
import { usePromise } from "@raycast/utils";
import { closeWindow, focusWindow, isHostRunning, listWindows, type GlimpseWindow } from "./lib/control";

function subtitleFor(win: GlimpseWindow): string {
  const bits = [`${win.width}×${win.height}`];
  if (win.floating) bits.push("floating");
  if (win.miniaturized) bits.push("minimized");
  if (!win.visible) bits.push("hidden");
  return bits.join(" · ");
}

export default function Command() {
  const [search, setSearch] = useState("");
  const { data, isLoading, error, revalidate } = usePromise(async () => {
    if (!isHostRunning()) {
      return { windows: [] as GlimpseWindow[], offline: true as const };
    }
    const res = await listWindows();
    return { windows: res.windows, offline: false as const };
  });

  const windows = (data?.windows ?? []).filter((w) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return w.title.toLowerCase().includes(q) || w.id.toLowerCase().includes(q);
  });

  const onFocus = useCallback(
    async (win: GlimpseWindow) => {
      try {
        await focusWindow(win.id);
        await closeMainWindow({ clearRootSearch: true });
        await popToRoot({ clearSearchBar: true });
      } catch (e) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Failed to focus window",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [],
  );

  const onClose = useCallback(
    async (win: GlimpseWindow) => {
      try {
        await closeWindow(win.id);
        await showToast({ style: Toast.Style.Success, title: `Closed ${win.title}` });
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
          title="Could not talk to Glimpse"
          description={error.message}
        />
      </List>
    );
  }

  if (data?.offline) {
    return (
      <List>
        <List.EmptyView
          icon={Icon.Window}
          title="No Glimpse host running"
          description="Open a Glimpse window from your agent/script first, then re-run this command."
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter Glimpse windows…"
      onSearchTextChange={setSearch}
      throttle
    >
      {windows.length === 0 ? (
        <List.EmptyView
          icon={Icon.Window}
          title="No open Glimpse windows"
          description="Host is up, but there are no windows right now."
        />
      ) : (
        windows.map((win) => (
          <List.Item
            key={win.id}
            title={win.title}
            subtitle={subtitleFor(win)}
            icon={{
              source: win.active ? Icon.CheckCircle : Icon.Window,
              tintColor: win.active ? Color.Green : Color.SecondaryText,
            }}
            accessories={[
              ...(win.active ? [{ tag: { value: "active", color: Color.Green } }] : []),
              { text: win.id.slice(0, 8) },
            ]}
            actions={
              <ActionPanel>
                <Action title="Focus Window" icon={Icon.ArrowRight} onAction={() => onFocus(win)} />
                <Action
                  title="Close Window"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() => onClose(win)}
                />
                <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={() => revalidate()} />
                <Action.CopyToClipboard title="Copy Window ID" content={win.id} />
                <Action.CopyToClipboard title="Copy Title" content={win.title} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
