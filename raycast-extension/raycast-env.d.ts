/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `browse-gapps` command */
  export type BrowseGapps = ExtensionPreferences & {}
  /** Preferences accessible in the `run-gapp` command */
  export type RunGapp = ExtensionPreferences & {}
  /** Preferences accessible in the `list-windows` command */
  export type ListWindows = ExtensionPreferences & {}
  /** Preferences accessible in the `focus-active` command */
  export type FocusActive = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `browse-gapps` command */
  export type BrowseGapps = {}
  /** Arguments passed to the `run-gapp` command */
  export type RunGapp = {}
  /** Arguments passed to the `list-windows` command */
  export type ListWindows = {}
  /** Arguments passed to the `focus-active` command */
  export type FocusActive = {}
}

