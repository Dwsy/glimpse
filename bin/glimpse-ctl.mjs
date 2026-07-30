#!/usr/bin/env node
/**
 * CLI for external control of the running Glimpse host (list / focus / close).
 *
 *   glimpse-ctl list
 *   glimpse-ctl focus <id>
 *   glimpse-ctl close <id>
 *   glimpse-ctl ping
 */
import {
  listWindows,
  focusWindow,
  closeWindow,
  ping,
  controlSocketPath,
  isControlSocketAvailable,
} from '../src/control-client.mjs';

const [cmd, arg] = process.argv.slice(2);

function usage() {
  console.log(`glimpse-ctl — control a running Glimpse host

Usage:
  glimpse-ctl list              List open windows (JSON)
  glimpse-ctl focus <id>        Focus / activate a window
  glimpse-ctl close <id>        Close a window
  glimpse-ctl ping              Health check

Socket: ${controlSocketPath()}
Env:    GLIMPSE_CONTROL_SOCK to override path
`);
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (!isControlSocketAvailable()) {
    console.error(`No Glimpse host running.\nExpected socket: ${controlSocketPath()}`);
    process.exit(2);
  }

  try {
    switch (cmd) {
      case 'list': {
        const res = await listWindows();
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'focus':
      case 'activate': {
        if (!arg) {
          console.error('focus requires a window id');
          process.exit(1);
        }
        const res = await focusWindow(arg);
        console.log(JSON.stringify(res));
        break;
      }
      case 'close': {
        if (!arg) {
          console.error('close requires a window id');
          process.exit(1);
        }
        const res = await closeWindow(arg);
        console.log(JSON.stringify(res));
        break;
      }
      case 'ping': {
        const res = await ping();
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();
