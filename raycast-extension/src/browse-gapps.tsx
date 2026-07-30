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
  open as openPath,
  confirmAlert,
  Alert,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import {
  catalogGapps,
  runGapp,
  listVersions,
  restoreVersion,
  setGappStatus,
  listRuns,
  listGlobalRuns,
  type CatalogSection,
  type GappMeta,
  type VersionEntry,
  projectLabel,
} from "./lib/gapp";

function appAccessories(app: GappMeta): { tag?: { value: string; color?: Color }; text?: string }[] {
  const acc: { tag?: { value: string; color?: Color }; text?: string }[] = [];
  if (app.version != null) acc.push({ tag: { value: `v${app.version}` } });
  if (app.runCount) acc.push({ text: `${app.runCount} runs` });
  if (!app.enabled) acc.push({ tag: { value: "off", color: Color.SecondaryText } });
  if (app.archived) acc.push({ tag: { value: "archived", color: Color.Orange } });
  return acc;
}

function AppActions({
  app,
  section,
  onRefresh,
}: {
  app: GappMeta;
  section: CatalogSection;
  onRefresh: () => void;
}) {
  const cwd = section.cwd || app.cwd || undefined;

  const openApp = useCallback(async () => {
    try {
      await runGapp(app.id, { cwd, scope: app.scope });
      await closeMainWindow({ clearRootSearch: true });
      await showToast({ style: Toast.Style.Success, title: `Opened ${app.name}` });
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Open failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [app, cwd]);

  const toggleEnable = useCallback(async () => {
    try {
      await setGappStatus(app.id, { enabled: !app.enabled, archived: false }, cwd);
      await showToast({
        style: Toast.Style.Success,
        title: app.enabled ? "Disabled" : "Enabled",
      });
      onRefresh();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Status update failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [app, cwd, onRefresh]);

  const archive = useCallback(async () => {
    const ok = await confirmAlert({
      title: `Archive ${app.name}?`,
      message: "App stays on disk but is offline from catalogs.",
      primaryAction: { title: "Archive", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    try {
      await setGappStatus(app.id, { archived: true }, cwd);
      await showToast({ style: Toast.Style.Success, title: "Archived" });
      onRefresh();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Archive failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [app, cwd, onRefresh]);

  return (
    <ActionPanel>
      <Action title="Open (Isolated Runner)" icon={Icon.Play} onAction={openApp} />
      <Action.Push
        title="Version History"
        icon={Icon.Clock}
        target={<VersionHistoryView app={app} cwd={cwd} onRefresh={onRefresh} />}
      />
      <Action.Push
        title="Run History"
        icon={Icon.List}
        target={<RunHistoryView app={app} cwd={cwd} />}
      />
      <Action
        title={app.enabled ? "Disable" : "Enable"}
        icon={app.enabled ? Icon.EyeDisabled : Icon.Eye}
        onAction={toggleEnable}
      />
      <Action title="Archive" icon={Icon.Tray} style={Action.Style.Destructive} onAction={archive} />
      <Action.CopyToClipboard title="Copy ID" content={app.id} />
      <Action.CopyToClipboard title="Copy Name" content={app.name} />
      {cwd ? (
        <Action title="Reveal Project" icon={Icon.Finder} onAction={() => openPath(cwd)} />
      ) : null}
      <Action title="Refresh Catalog" icon={Icon.ArrowClockwise} onAction={onRefresh} />
    </ActionPanel>
  );
}

function VersionHistoryView({
  app,
  cwd,
  onRefresh,
}: {
  app: GappMeta;
  cwd?: string;
  onRefresh: () => void;
}) {
  const { data, isLoading, error, revalidate } = usePromise(() => listVersions(app.id, cwd));

  const restore = async (v: VersionEntry) => {
    const ok = await confirmAlert({
      title: `Restore version ${v.id.slice(0, 20)}…?`,
      message: "Current HTML/state will be snapshotted first, then replaced.",
      primaryAction: { title: "Restore" },
    });
    if (!ok) return;
    try {
      await restoreVersion(app.id, v.id, cwd);
      await showToast({ style: Toast.Style.Success, title: "Restored" });
      revalidate();
      onRefresh();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Restore failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const openAt = async (v: VersionEntry) => {
    try {
      await runGapp(app.id, { cwd, scope: app.scope, versionId: v.id });
      await closeMainWindow();
    } catch (e) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Open version failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <List isLoading={isLoading} navigationTitle={`History · ${app.name}`}>
      {error ? (
        <List.EmptyView title="Failed to load versions" description={error.message} />
      ) : !data?.length ? (
        <List.EmptyView
          title="No version snapshots yet"
          description="Snapshots are created on each upsert/save via gapp-sdk."
        />
      ) : (
        data.map((v) => (
          <List.Item
            key={v.id}
            title={v.at}
            subtitle={`${v.reason}${v.version != null ? ` · v${v.version}` : ""}`}
            accessories={v.contentHash ? [{ text: v.contentHash }] : []}
            actions={
              <ActionPanel>
                <Action title="Open This Version" icon={Icon.Play} onAction={() => openAt(v)} />
                <Action title="Restore as Current" icon={Icon.Undo} onAction={() => restore(v)} />
                <Action.CopyToClipboard title="Copy Version ID" content={v.id} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}

function RunHistoryView({ app, cwd }: { app: GappMeta; cwd?: string }) {
  const { data, isLoading, error } = usePromise(() => listRuns(app.id, cwd));
  return (
    <List isLoading={isLoading} navigationTitle={`Runs · ${app.name}`}>
      {error ? (
        <List.EmptyView title="Failed to load runs" description={error.message} />
      ) : !data?.length ? (
        <List.EmptyView title="No runs recorded" description="Open the app once to record a run." />
      ) : (
        data.map((r: any, i: number) => (
          <List.Item
            key={`${r.at}-${i}`}
            title={r.at}
            subtitle={[r.source, r.version != null ? `v${r.version}` : null].filter(Boolean).join(" · ")}
          />
        ))
      )}
    </List>
  );
}

export default function Command() {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading, error, revalidate } = usePromise(
    async (includeAll: boolean) =>
      catalogGapps({
        includeArchived: includeAll,
        includeDisabled: includeAll,
      }),
    [showAll],
  );

  const sections: CatalogSection[] = data ?? [];

  if (error) {
    return (
      <List>
        <List.EmptyView icon={Icon.Warning} title="GAPP SDK error" description={error.message} />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter GAPPs by name or id…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter"
          value={showAll ? "all" : "active"}
          onChange={(v) => setShowAll(v === "all")}
        >
          <List.Dropdown.Item title="Active only" value="active" />
          <List.Dropdown.Item title="Include disabled/archived" value="all" />
        </List.Dropdown>
      }
    >
      {!sections.length ? (
        <List.EmptyView
          icon={Icon.AppWindowList}
          title="No GAPPs found"
          description="Create one via Pi gapp_upsert, or open a project that has .pi/gapp/"
        />
      ) : (
        sections.map((section) => (
          <List.Section
            key={section.key}
            title={section.label}
            subtitle={
              section.cwd
                ? `${section.apps.length} apps · ${section.cwd}`
                : `${section.apps.length} apps · ~/.pi/gapp`
            }
          >
            {section.apps.map((app) => (
              <List.Item
                key={`${section.key}:${app.id}`}
                title={app.name}
                subtitle={app.description || app.id}
                icon={{
                  source: app.archived ? Icon.Tray : app.enabled ? Icon.AppWindow : Icon.Circle,
                  tintColor: app.enabled && !app.archived ? Color.Blue : Color.SecondaryText,
                }}
                accessories={appAccessories(app)}
                actions={<AppActions app={app} section={section} onRefresh={() => revalidate()} />}
              />
            ))}
          </List.Section>
        ))
      )}
      <List.Section title="Recent runs (global)">
        <RecentRunsItem />
      </List.Section>
    </List>
  );
}

function RecentRunsItem() {
  const { data, isLoading } = usePromise(() => listGlobalRuns(15));
  if (isLoading) {
    return <List.Item title="Loading recent runs…" icon={Icon.Clock} />;
  }
  if (!data?.length) {
    return <List.Item title="No global run log yet" icon={Icon.Clock} />;
  }
  // Show as one expandable summary + push for detail would be heavy; list top runs inline
  return (
    <>
      {data.slice(0, 8).map((r: any, i: number) => (
        <List.Item
          key={`run-${i}-${r.at}`}
          title={r.name || r.id}
          subtitle={`${projectLabel(r.cwd)} · ${r.at}`}
          icon={Icon.Play}
          accessories={r.version != null ? [{ tag: { value: `v${r.version}` } }] : []}
          actions={
            <ActionPanel>
              <Action
                title="Open This GAPP"
                icon={Icon.Play}
                onAction={async () => {
                  try {
                    await runGapp(r.id, { cwd: r.cwd || undefined });
                    await closeMainWindow();
                  } catch (e) {
                    await showToast({
                      style: Toast.Style.Failure,
                      title: "Open failed",
                      message: e instanceof Error ? e.message : String(e),
                    });
                  }
                }}
              />
              <Action.CopyToClipboard title="Copy ID" content={r.id} />
            </ActionPanel>
          }
        />
      ))}
    </>
  );
}
