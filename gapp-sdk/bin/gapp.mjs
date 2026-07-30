#!/usr/bin/env node
/**
 * Portable GAPP CLI (no Pi agent required).
 *
 *   gapp list [--all] [--cwd path]
 *   gapp catalog
 *   gapp open <id> [--cwd path] [--version <stamp>]
 *   gapp history <id>
 *   gapp runs [id]
 *   gapp enable|disable|archive <id>
 */
import {
  listGapps,
  catalogGapps,
  listVersions,
  listRuns,
  listGlobalRuns,
  setGappStatus,
  resolveGapp,
  runGappUntilClosed,
  GappValidationError,
} from "../src/index.mjs";

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--all") flags.all = true;
  else if (a === "--cwd" && args[i + 1]) flags.cwd = args[++i];
  else if (a === "--version" && args[i + 1]) flags.version = args[++i];
  else if (a === "--json") flags.json = true;
  else if (a === "-h" || a === "--help") flags.help = true;
  else if (!a.startsWith("-")) positional.push(a);
}

const [cmd, id] = positional;
const cwd = flags.cwd || process.cwd();

function usage() {
  console.log(`gapp — portable Glimpse-APP CLI (SDK)

Usage:
  gapp list [--all] [--cwd <path>] [--json]
  gapp catalog [--all] [--json]
  gapp open <id> [--cwd <path>] [--version <stamp>]
  gapp history <id> [--cwd <path>] [--json]
  gapp runs [id] [--json]
  gapp enable|disable|archive <id> [--cwd <path>]
  gapp info <id> [--cwd <path>]

Environment:
  GLIMPSEUI_PATH   Override glimpseui package root
  GAPP_GLOBAL_DIR  Override ~/.pi/gapp
`);
}

async function main() {
  if (flags.help || !cmd) {
    usage();
    process.exit(flags.help ? 0 : 1);
  }

  try {
    switch (cmd) {
      case "list": {
        const apps = await listGapps({
          cwd,
          includeArchived: flags.all,
          includeDisabled: flags.all,
        });
        if (flags.json) {
          console.log(JSON.stringify(apps, null, 2));
        } else {
          for (const a of apps) {
            const flags_ = [
              a.scope,
              a.enabled ? "on" : "off",
              a.archived ? "archived" : null,
              a.version != null ? `v${a.version}` : null,
              a.runCount ? `runs:${a.runCount}` : null,
            ]
              .filter(Boolean)
              .join(" ");
            console.log(`${a.id.padEnd(24)} ${a.name}  (${flags_})`);
          }
          if (!apps.length) console.log("(no gapps)");
        }
        break;
      }
      case "catalog": {
        const sections = await catalogGapps({
          cwd,
          includeArchived: flags.all,
          includeDisabled: flags.all,
        });
        if (flags.json) {
          console.log(JSON.stringify(sections, null, 2));
        } else {
          for (const s of sections) {
            console.log(`\n## ${s.label}${s.cwd ? `  [${s.cwd}]` : ""}`);
            for (const a of s.apps) {
              console.log(`  - ${a.id}  ${a.name}  v${a.version ?? "?"}  runs:${a.runCount ?? 0}`);
            }
            if (!s.apps.length) console.log("  (empty)");
          }
        }
        break;
      }
      case "open": {
        if (!id) throw new GappValidationError("open requires <id>");
        console.error(`Opening ${id}…`);
        await runGappUntilClosed(id, {
          cwd,
          versionId: flags.version,
          source: "cli",
        });
        break;
      }
      case "history": {
        if (!id) throw new GappValidationError("history requires <id>");
        const versions = await listVersions(id, { cwd });
        if (flags.json) console.log(JSON.stringify(versions, null, 2));
        else {
          for (const v of versions) {
            console.log(`${v.id}  ${v.at}  ${v.reason}  hash=${v.contentHash}`);
          }
          if (!versions.length) console.log("(no versions yet — save/upsert once)");
        }
        break;
      }
      case "runs": {
        if (id) {
          const runs = await listRuns(id, { cwd });
          if (flags.json) console.log(JSON.stringify(runs, null, 2));
          else runs.forEach((r) => console.log(`${r.at}  ${r.source || ""}  v${r.version ?? "?"}`));
        } else {
          const runs = await listGlobalRuns(50);
          if (flags.json) console.log(JSON.stringify(runs, null, 2));
          else runs.forEach((r) => console.log(`${r.at}  ${r.id}  ${r.name}  ${r.cwd || "global"}`));
        }
        break;
      }
      case "enable":
      case "disable":
      case "archive": {
        if (!id) throw new GappValidationError(`${cmd} requires <id>`);
        const status =
          cmd === "enable"
            ? { enabled: true, archived: false }
            : cmd === "disable"
              ? { enabled: false }
              : { archived: true };
        const meta = await setGappStatus(id, status, { cwd });
        console.log(JSON.stringify(meta, null, 2));
        break;
      }
      case "info": {
        if (!id) throw new GappValidationError("info requires <id>");
        const bundle = await resolveGapp(id, cwd);
        if (!bundle) throw new GappValidationError(`not found: ${id}`);
        console.log(JSON.stringify({ meta: bundle.meta, dir: bundle.dir }, null, 2));
        break;
      }
      default:
        usage();
        process.exit(1);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

main();
