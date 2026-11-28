// @effect-migrated
import { Schema, Struct } from 'effect';
import { desktopInfoSchema } from './desktop.js';
// The contract between the desktop webview and the Rust host: what each
// native command answers. The webview decodes every reply with its schema, so
// a host that answers in another shape fails the call instead of reaching the
// UI. Commands that return `()` answer null (Tauri serializes their reply with
// serde_json).
/** A schema the desktop decodes a reply with, without services. */
type Reply = Schema.Codec<unknown, unknown>;

const nothing = Schema.Null;

/** What the host reports after updating the addon on launch. */
export const addonUpdateSchema = desktopInfoSchema.mapFields(
  Struct.pick(['wow', 'addonOutdated', 'addonUpdateNotice', 'addonUpdatePending']),
);
export type AddonUpdate = typeof addonUpdateSchema.Type;

export const updateChannelSchema = Schema.Literals(['stable', 'nightly']);
export type UpdateChannel = typeof updateChannelSchema.Type;

/** `downgrade`: older than the installed version, offered only when returning to Stable. */
export const releaseSchema = Schema.Struct({
  version: Schema.String,
  notes: Schema.NullOr(Schema.String),
  downgrade: Schema.Boolean,
});
export type Release = typeof releaseSchema.Type;

/** The installer window's progress. */
export const installerStatusSchema = Schema.Struct({
  phase: Schema.Literals(['preparing', 'installing', 'reopening', 'failed']),
  percent: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  log: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type InstallerStatus = typeof installerStatusSchema.Type;

export const nativeCommands = {
  // The bridge's reply, which the caller decodes with the route's own contract.
  bridge_request: Schema.Unknown,
  desktop_info: desktopInfoSchema,
  /** Null when no addon update was pending. */
  auto_update_addon: Schema.NullOr(addonUpdateSchema),
  detect_game_folders: Schema.Array(Schema.String),
  start_bridge: nothing,
  /** Null when the player closed the picker. */
  pick_folder: Schema.NullOr(Schema.String),
  install_addon: Schema.String,
  open_sign_in: nothing,
  open_exa_dashboard: nothing,
  open_logs: nothing,
  read_logs: Schema.String,
  import_legacy: Schema.String,
  telemetry_settings: Schema.Struct({ enabled: Schema.Boolean, active: Schema.Boolean }),
  telemetry_screen: nothing,
  telemetry_onboarding: nothing,
  update_channel: updateChannelSchema,
  check_update: Schema.Struct({ supported: Schema.Boolean, update: Schema.NullOr(releaseSchema) }),
  /** The version of the verified installer. */
  download_update: Schema.String,
  install_update: nothing,
  update_auto_install: Schema.Boolean,
  game_running: Schema.Boolean,
  notify: nothing,
  autostart_enabled: Schema.Boolean,
  set_autostart: Schema.Boolean,
  // The installer window's own commands.
  updater_ready: nothing,
  updater_status: installerStatusSchema,
  updater_close: nothing,
} satisfies Record<string, Reply>;

export type NativeCommands = typeof nativeCommands;
export type NativeCommand = keyof NativeCommands;
export type NativeReply<C extends NativeCommand> = NativeCommands[C]['Type'];
