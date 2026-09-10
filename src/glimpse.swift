import Cocoa
import WebKit
import UniformTypeIdentifiers
@preconcurrency import UserNotifications
import Foundation
import Darwin

// MARK: - Stdout Helper

func writeToStdout(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: data, encoding: .utf8) else { return }
    let output = line + "\n"
    FileHandle.standardOutput.write(output.data(using: .utf8)!)
    fflush(stdout)
}

/// Protocol event helper — always attaches window `id` when multi-window host is used.
func writeEvent(_ dict: [String: Any], id: String? = nil) {
    var payload = dict
    if let id { payload["id"] = id }
    writeToStdout(payload)
}

func log(_ message: String) {
    fputs("[glimpse] \(message)\n", stderr)
}

/// Resolve AppIcon next to the binary, inside Glimpse.app, or under ../assets.
func resolveAppIconURL() -> URL? {
    let exe = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    let candidates: [URL] = [
        // Glimpse.app/Contents/Resources/AppIcon.icns
        exe.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/AppIcon.icns"),
        exe.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/AppIcon-1024.png"),
        // next to binary
        exe.deletingLastPathComponent().appendingPathComponent("AppIcon.icns"),
        exe.deletingLastPathComponent().appendingPathComponent("AppIcon-1024.png"),
        // dev tree: src/glimpse → ../assets/
        exe.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("assets/AppIcon.icns"),
        exe.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("assets/AppIcon-1024.png"),
    ]
    for url in candidates where FileManager.default.fileExists(atPath: url.path) {
        return url
    }
    return nil
}

func loadAppIconImage() -> NSImage? {
    guard let url = resolveAppIconURL() else { return nil }
    return NSImage(contentsOf: url)
}

// MARK: - External Control Socket (Raycast / CLI)

/// Unix domain socket used by Raycast extension and `glimpse-ctl` to list / focus / close windows.
func controlSocketPath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let dir = (home as NSString).appendingPathComponent("Library/Application Support/dev.glimpse.ui")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return (dir as NSString).appendingPathComponent("control.sock")
}

func controlPidPath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let dir = (home as NSString).appendingPathComponent("Library/Application Support/dev.glimpse.ui")
    return (dir as NSString).appendingPathComponent("host.pid")
}

func writeJSONLineToFD(_ fd: Int32, _ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    line.withCString { ptr in
        _ = write(fd, ptr, strlen(ptr))
    }
}

// MARK: - System Info

func getSystemInfo() -> [String: Any] {
    let mouse = NSEvent.mouseLocation

    // Main screen
    var screenInfo: [String: Any] = [:]
    if let screen = NSScreen.main {
        let f = screen.frame
        let v = screen.visibleFrame
        screenInfo = [
            "width": Int(f.width),
            "height": Int(f.height),
            "scaleFactor": Int(screen.backingScaleFactor),
            "visibleX": Int(v.origin.x),
            "visibleY": Int(v.origin.y),
            "visibleWidth": Int(v.width),
            "visibleHeight": Int(v.height),
        ]
    }

    // All screens
    let screens: [[String: Any]] = NSScreen.screens.map { screen in
        let f = screen.frame
        let v = screen.visibleFrame
        return [
            "x": Int(f.origin.x),
            "y": Int(f.origin.y),
            "width": Int(f.width),
            "height": Int(f.height),
            "scaleFactor": Int(screen.backingScaleFactor),
            "visibleX": Int(v.origin.x),
            "visibleY": Int(v.origin.y),
            "visibleWidth": Int(v.width),
            "visibleHeight": Int(v.height),
        ]
    }

    // Appearance
    let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB)
    let accentHex: String
    if let c = accent {
        accentHex = String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    } else {
        accentHex = "#007AFF"
    }
    let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast

    return [
        "screen": screenInfo,
        "screens": screens,
        "appearance": [
            "darkMode": isDark,
            "accentColor": accentHex,
            "reduceMotion": reduceMotion,
            "increaseContrast": increaseContrast,
        ],
        "cursor": [
            "x": Int(mouse.x),
            "y": Int(mouse.y),
        ],
    ]
}

// MARK: - Cursor Anchor

let safeZoneLeft: CGFloat = 20
let safeZoneRight: CGFloat = 27
let safeZoneUp: CGFloat = 15
let safeZoneDown: CGFloat = 39

func anchorPosition(mouse: NSPoint, windowSize: NSSize, anchor: String) -> NSPoint? {
    let cx = mouse.x
    let cy = mouse.y
    let W = windowSize.width
    let H = windowSize.height
    let sL = safeZoneLeft
    let sR = safeZoneRight
    let sU = safeZoneUp
    let sD = safeZoneDown
    switch anchor {
    case "top-left":
        return NSPoint(x: cx - sL - W, y: cy + sU)
    case "top-right":
        return NSPoint(x: cx + sR, y: cy + sU)
    case "right":
        return NSPoint(x: cx + sR, y: cy - H / 2)
    case "bottom-right":
        return NSPoint(x: cx + sR, y: cy - sD - H)
    case "bottom-left":
        return NSPoint(x: cx - sL - W, y: cy - sD - H)
    case "left":
        return NSPoint(x: cx - sL - W, y: cy - H / 2)
    default:
        return nil
    }
}

// MARK: - CLI Config

struct Config {
    var width: Int = 800
    var height: Int = 600
    var title: String = "Glimpse"
    var frameless: Bool = false
    var floating: Bool = false
    var transparent: Bool = false
    var x: Int? = nil
    var y: Int? = nil
    var followCursor: Bool = false
    var cursorOffsetX: Int = 20
    var cursorOffsetY: Int = -20
    var clickThrough: Bool = false
    var hidden: Bool = false
    var autoClose: Bool = false
    var cursorAnchor: String? = nil
    var followMode: String = "snap"
    var openLinks: Bool = false
    var openLinksApp: String? = nil
    /// Browser-style in-page search. Opt-in so existing menu-less windows keep their current behavior.
    var findInPage: Bool = false
    var statusItem: Bool = false
    /// Multi-window host: stay alive, open windows via `{"type":"open",...}` protocol.
    var hostMode: Bool = false
    /// Default window id for single-window / first window.
    var windowId: String = "main"
}

func configFromOpenCommand(_ json: [String: Any], defaults: Config) -> Config {
    var c = defaults
    if let v = json["width"] as? Int { c.width = v }
    if let v = json["height"] as? Int { c.height = v }
    if let v = json["title"] as? String { c.title = v }
    if let v = json["frameless"] as? Bool { c.frameless = v }
    if let v = json["floating"] as? Bool { c.floating = v }
    if let v = json["transparent"] as? Bool { c.transparent = v }
    if let v = json["clickThrough"] as? Bool { c.clickThrough = v }
    if let v = json["hidden"] as? Bool { c.hidden = v }
    if let v = json["autoClose"] as? Bool { c.autoClose = v }
    if let v = json["followCursor"] as? Bool { c.followCursor = v }
    if let v = json["cursorOffsetX"] as? Int { c.cursorOffsetX = v }
    if let v = json["cursorOffsetY"] as? Int { c.cursorOffsetY = v }
    if let v = json["cursorAnchor"] as? String { c.cursorAnchor = v }
    if let v = json["followMode"] as? String { c.followMode = v }
    if let v = json["openLinks"] as? Bool { c.openLinks = v }
    if let v = json["findInPage"] as? Bool { c.findInPage = v }
    if let v = json["openLinksApp"] as? String {
        c.openLinks = true
        c.openLinksApp = v
    }
    if let v = json["x"] as? Int { c.x = v }
    if let v = json["y"] as? Int { c.y = v }
    c.statusItem = false
    c.hostMode = defaults.hostMode
    return c
}

func parseArgs() -> Config {
    var config = Config()
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--width":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.width = v }
        case "--height":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.height = v }
        case "--title":
            i += 1
            if i < args.count { config.title = args[i] }
        case "--frameless":
            config.frameless = true
        case "--floating":
            config.floating = true
        case "--transparent":
            config.transparent = true
        case "--x":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.x = v }
        case "--y":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.y = v }
        case "--follow-cursor":
            config.followCursor = true
        case "--cursor-offset-x":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.cursorOffsetX = v }
        case "--cursor-offset-y":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.cursorOffsetY = v }
        case "--click-through":
            config.clickThrough = true
        case "--hidden":
            config.hidden = true
        case "--auto-close":
            config.autoClose = true
        case "--cursor-anchor":
            i += 1
            if i < args.count { config.cursorAnchor = args[i] }
        case "--follow-mode":
            i += 1
            if i < args.count { config.followMode = args[i] }
        case "--open-links":
            config.openLinks = true
        case "--find-in-page":
            config.findInPage = true
        case "--open-links-app":
            i += 1
            if i < args.count {
                config.openLinks = true
                config.openLinksApp = args[i]
            }
        case "--status-item":
            config.statusItem = true
        case "--host":
            config.hostMode = true
        case "--id":
            i += 1
            if i < args.count { config.windowId = args[i] }
        default:
            break
        }
        i += 1
    }
    // When anchor is set, offsets default to 0 (fine-tuning only).
    // The non-zero defaults (20, -20) are for offset-only mode.
    if config.cursorAnchor != nil {
        var explicitOffsetX = false
        var explicitOffsetY = false
        var j = 1
        while j < args.count {
            if args[j] == "--cursor-offset-x" { explicitOffsetX = true }
            if args[j] == "--cursor-offset-y" { explicitOffsetY = true }
            j += 1
        }
        if !explicitOffsetX { config.cursorOffsetX = 0 }
        if !explicitOffsetY { config.cursorOffsetY = 0 }
    }
    return config
}

// MARK: - WebView Bridge

let bridgeJS = """
window.glimpse = {
    cursorTip: null,
    windowFocused: document.hasFocus(),
    send: function(data) {
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify(data));
    },
    close: function() {
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({__glimpse_close: true}));
    },
    setNativeGlassRegions: function(regions) {
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
            __glimpse_native_glass: Array.isArray(regions) ? regions : []
        }));
    },
    setWindowDragRegions: function(regions) {
        var value = regions && typeof regions === 'object' ? regions : {drag: [], noDrag: []};
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
            __glimpse_window_drag_regions: value
        }));
    }
};
(function installNativeThemeBridge() {
    var nextRequestId = 1;
    var pending = new Map();
    var notificationListeners = new Map();

    function postNativeTheme(method, argument) {
        return new Promise(function(resolve, reject) {
            var id = 'native-theme-' + nextRequestId++;
            pending.set(id, { resolve: resolve, reject: reject });
            window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
                __glimpse_native_theme: {
                    id: id,
                    method: method,
                    argument: argument === undefined ? null : argument
                }
            }));
        });
    }

    window.__GLIMPSE_NATIVE_THEME_RESOLVE__ = function(id, result, error) {
        var request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (error) request.reject(new Error(String(error)));
        else request.resolve(result);
    };

    window.__GLIMPSE_NATIVE_THEME_NOTIFY__ = function(channel, params) {
        var listeners = notificationListeners.get(channel);
        if (!listeners) return;
        Array.from(listeners).forEach(function(listener) { listener(params); });
    };

    var api = window.glazeAPI || {};
    var nativeTheme = api.nativeTheme || {};
    if (typeof nativeTheme.getInfo !== 'function') {
        nativeTheme.getInfo = function() { return postNativeTheme('getInfo'); };
    }
    if (typeof nativeTheme.setThemeSource !== 'function') {
        nativeTheme.setThemeSource = function(source) { return postNativeTheme('setThemeSource', source); };
    }
    if (typeof nativeTheme.getShouldUseDarkColors !== 'function') {
        nativeTheme.getShouldUseDarkColors = function() { return postNativeTheme('getShouldUseDarkColors'); };
    }
    if (typeof nativeTheme.getThemeSource !== 'function') {
        nativeTheme.getThemeSource = function() { return postNativeTheme('getThemeSource'); };
    }
    api.nativeTheme = nativeTheme;

    var glaze = api.glaze || {};
    var ipc = glaze.ipc || {};
    if (typeof ipc.onNotification !== 'function') {
        ipc.onNotification = function(channel, callback) {
            if (typeof callback !== 'function') return function() {};
            var listeners = notificationListeners.get(channel);
            if (!listeners) {
                listeners = new Set();
                notificationListeners.set(channel, listeners);
            }
            listeners.add(callback);
            return function() {
                listeners.delete(callback);
                if (listeners.size === 0) notificationListeners.delete(channel);
            };
        };
    }
    glaze.ipc = ipc;
    api.glaze = glaze;
    window.glazeAPI = api;
})();
(function installNativeImageBridge() {
    var nextRequestId = 1;
    var pending = new Map();
    var setTimer = typeof window.setTimeout === 'function'
        ? window.setTimeout.bind(window)
        : function() { return 0; };
    var clearTimer = typeof window.clearTimeout === 'function'
        ? window.clearTimeout.bind(window)
        : function() {};
    var supportedChannels = new Set([
        'nativeImage:createFromNamedImage',
        'nativeImage:createFromPath'
    ]);

    function setNativeImageDebug(stage, details) {
        window.__GLIMPSE_NATIVE_IMAGE_DEBUG__ = Object.assign({ stage: stage, time: Date.now() }, details || {});
    }

    function invokeNativeImage(channel, argument) {
        if (!supportedChannels.has(channel)) {
            return Promise.reject(new Error('Unsupported Glimpse IPC channel: ' + String(channel)));
        }
        return new Promise(function(resolve, reject) {
            var id = 'native-image-' + nextRequestId++;
            setNativeImageDebug('posting', { id: id, channel: channel });
            var timeout = setTimer(function() {
                if (!pending.has(id)) return;
                pending.delete(id);
                setNativeImageDebug('timeout', { id: id, channel: channel });
                reject(new Error('Native image request timed out'));
            }, 5000);
            pending.set(id, { resolve: resolve, reject: reject, timeout: timeout });
            try {
                window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
                    __glimpse_native_image: {
                        id: id,
                        channel: channel,
                        argument: argument && typeof argument === 'object' ? argument : {}
                    }
                }));
                setNativeImageDebug('posted', { id: id, channel: channel });
            } catch (postError) {
                pending.delete(id);
                clearTimer(timeout);
                setNativeImageDebug('post-error', { id: id, channel: channel, error: String(postError) });
                reject(postError);
            }
        });
    }

    window.__GLIMPSE_NATIVE_IMAGE_RESOLVE__ = function(id, result, error) {
        var request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        clearTimer(request.timeout);
        setNativeImageDebug(error ? 'rejected' : 'resolved', { id: id, error: error ? String(error) : null });
        if (error) request.reject(new Error(String(error)));
        else request.resolve(result);
    };

    function wrapCurrentInvoke() {
        var api = window.glazeAPI || {};
        var glaze = api.glaze || {};
        var ipc = glaze.ipc || {};
        if (ipc.invoke && ipc.invoke.__glimpseNativeImageBridge === true) return;
        var delegatedInvoke = typeof ipc.invoke === 'function' ? ipc.invoke.bind(ipc) : null;
        var wrappedInvoke = function(channel, argument) {
            setNativeImageDebug('wrapped', { channel: String(channel), supported: supportedChannels.has(channel) });
            if (supportedChannels.has(channel)) return invokeNativeImage(channel, argument);
            if (delegatedInvoke) return delegatedInvoke.apply(null, arguments);
            return Promise.reject(new Error('Unsupported Glimpse IPC channel: ' + String(channel)));
        };
        Object.defineProperty(wrappedInvoke, '__glimpseNativeImageBridge', { value: true });
        try {
            Object.defineProperty(ipc, 'invoke', {
                configurable: true,
                enumerable: true,
                get: function() { return wrappedInvoke; },
                set: function(value) {
                    if (value === wrappedInvoke) return;
                    delegatedInvoke = typeof value === 'function' ? value.bind(ipc) : null;
                }
            });
        } catch (_) {
            ipc.invoke = wrappedInvoke;
        }
        glaze.ipc = ipc;
        api.glaze = glaze;
        window.glazeAPI = api;
    }

    wrapCurrentInvoke();
    function keepInvokeWrapped() {
        wrapCurrentInvoke();
        setTimer(keepInvokeWrapped, 250);
    }
    setTimer(keepInvokeWrapped, 0);
})();
(function installNativeMenuBridge() {
    var nextRequestId = 1;
    var pending = new Map();

    function postNativeMenu(method, options) {
        return new Promise(function(resolve, reject) {
            var id = 'native-menu-' + nextRequestId++;
            pending.set(id, { resolve: resolve, reject: reject });
            window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
                __glimpse_native_menu: {
                    id: id,
                    method: method,
                    options: options && typeof options === 'object' ? options : {}
                }
            }));
        });
    }

    window.__GLIMPSE_NATIVE_MENU_RESOLVE__ = function(id, result, error) {
        var request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (error) request.reject(new Error(String(error)));
        else request.resolve(result);
    };

    var api = window.glazeAPI || {};
    var menu = api.Menu || {};
    if (typeof menu.popup !== 'function') {
        menu.popup = function(options) { return postNativeMenu('popup', options); };
    }
    api.Menu = menu;
    window.glazeAPI = api;
})();
(function installOpenGlazeNotificationBridge() {
    var nextRequestId = 1;
    var instances = new Map();

    function normalizeString(value, fallback) {
        return typeof value === 'string' ? value : (fallback || '');
    }

    function OpenGlazeNotification(options) {
        options = options && typeof options === 'object' ? options : {};
        this.id = normalizeString(options.id, 'notification-' + Date.now() + '-' + nextRequestId++);
        this.title = normalizeString(options.title);
        this.subtitle = normalizeString(options.subtitle);
        this.body = normalizeString(options.body);
        this.silent = !!options.silent;
        this.sound = normalizeString(options.sound);
        this._listeners = new Map();
        this._shown = false;
        instances.set(this.id, this);
    }

    OpenGlazeNotification.isSupported = function() { return true; };
    OpenGlazeNotification.prototype.on = function(event, listener) {
        if (typeof listener !== 'function') return this;
        var listeners = this._listeners.get(event);
        if (!listeners) { listeners = new Set(); this._listeners.set(event, listeners); }
        listeners.add(listener);
        return this;
    };
    OpenGlazeNotification.prototype.once = function(event, listener) {
        if (typeof listener !== 'function') return this;
        var self = this;
        function wrapped() { self.off(event, wrapped); return listener.apply(self, arguments); }
        return this.on(event, wrapped);
    };
    OpenGlazeNotification.prototype.off = function(event, listener) {
        var listeners = this._listeners.get(event);
        if (listeners) {
            listeners.delete(listener);
            if (listeners.size === 0) this._listeners.delete(event);
        }
        return this;
    };
    OpenGlazeNotification.prototype._emit = function(event, payload) {
        var listeners = this._listeners.get(event);
        if (!listeners) return;
        Array.from(listeners).forEach(function(listener) { listener.call(this, payload || { type: event }); }, this);
    };
    OpenGlazeNotification.prototype.show = function() {
        this._shown = true;
        instances.set(this.id, this);
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
            __glimpse_native_notification: {
                method: 'show',
                id: this.id,
                options: {
                    id: this.id,
                    title: this.title,
                    subtitle: this.subtitle,
                    body: this.body,
                    silent: this.silent,
                    sound: this.sound
                }
            }
        }));
    };
    OpenGlazeNotification.prototype.close = function() {
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
            __glimpse_native_notification: { method: 'close', id: this.id }
        }));
    };

    window.__GLIMPSE_NATIVE_NOTIFICATION_EVENT__ = function(id, event, payload) {
        var instance = instances.get(id);
        if (!instance) return;
        if (event === 'close' || event === 'click' || event === 'failed') {
            instance._shown = false;
            if (event !== 'failed') instances.delete(id);
        }
        instance._emit(event, payload && typeof payload === 'object' ? payload : { type: event });
    };

    var openGlaze = window.openGlaze || {};
    openGlaze.Notification = OpenGlazeNotification;
    window.openGlaze = openGlaze;
})();
(function installNativeDialogBridge() {
    var nextRequestId = 1;
    var pending = new Map();

    function invokeNativeDialog(method, args) {
        return new Promise(function(resolve, reject) {
            var id = 'native-dialog-' + nextRequestId++;
            pending.set(id, { resolve: resolve, reject: reject });
            window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
                __glimpse_native_dialog: {
                    id: id,
                    method: method,
                    args: Array.isArray(args) ? args : []
                }
            }));
        });
    }

    window.__GLIMPSE_NATIVE_DIALOG_RESOLVE__ = function(id, result, error) {
        var request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (error) request.reject(new Error(String(error)));
        else request.resolve(result);
    };

    var api = window.glazeAPI || {};
    var dialog = api.dialog || {};
    dialog.showOpenDialog = function(options) {
        return invokeNativeDialog('showOpenDialog', [options && typeof options === 'object' ? options : {}]);
    };
    dialog.showSaveDialog = function(options) {
        return invokeNativeDialog('showSaveDialog', [options && typeof options === 'object' ? options : {}]);
    };
    dialog.showMessageBox = function(options) {
        return invokeNativeDialog('showMessageBox', [options && typeof options === 'object' ? options : {}]);
    };
    dialog.showErrorBox = function(title, content) {
        return invokeNativeDialog('showErrorBox', [title, content]);
    };
    api.dialog = dialog;
    window.glazeAPI = api;
})();
(function installNativeDatePickerBridge() {
    var nextRequestId = 1;
    var pending = new Map();

    function showDatePicker(options) {
        return new Promise(function(resolve, reject) {
            var id = 'native-date-picker-' + nextRequestId++;
            pending.set(id, { resolve: resolve, reject: reject });
            window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
                __glimpse_native_date_picker: {
                    id: id,
                    options: options && typeof options === 'object' ? options : {}
                }
            }));
        });
    }

    window.__GLIMPSE_NATIVE_DATE_PICKER_RESOLVE__ = function(id, result, error) {
        var request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (error) request.reject(new Error(String(error)));
        else request.resolve(result);
    };

    var api = window.glazeAPI || {};
    var dialog = api.dialog || {};
    if (typeof dialog.showDatePicker !== 'function') {
        dialog.showDatePicker = showDatePicker;
    }
    api.dialog = dialog;
    window.glazeAPI = api;
})();
(function installNativeChildWindowBridge() {
    try {
        var feature = new URL(window.location.href).searchParams.get('feature');
        if (feature !== 'tooltip' && feature !== 'hud') return;
        function postAnimation(action) {
            window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
                __glimpse_native_child_animation: { action: action }
            }));
        }
        window.resizeTo = function(width, height) {
            window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({
                __glimpse_native_child_resize: {
                    width: Number(width),
                    height: Number(height)
                }
            }));
        };
        if (feature === 'tooltip') {
            window.animateOut = function() { postAnimation('animateOut'); };
            window.cancelAnimateOut = function() { postAnimation('cancelAnimateOut'); };
        }
    } catch (_) {}
})();
window.__GAPP_WINDOW_FOCUSED__ = window.glimpse.windowFocused;
window.__GAPP_SET_WINDOW_FOCUS__ = function(focused) {
    var value = !!focused;
    window.__GAPP_WINDOW_FOCUSED__ = value;
    window.glimpse.windowFocused = value;
    if (document.documentElement) {
        document.documentElement.classList.toggle('window-blurred', !value);
    }
    window.dispatchEvent(new CustomEvent('gapp-window-focus', {
        detail: { focused: value }
    }));
};
"""

// MARK: - Window Subclass (keyboard support for frameless windows)

class GlimpsePanel: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// Compact browser-style find panel attached to one Glimpse window.
/// It uses WebKit's public find API and stays entirely inactive unless the
/// window was opened with `findInPage: true` / `--find-in-page`.
@MainActor
final class NativeFindPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class NativeFindController: NSObject, NSSearchFieldDelegate {
    weak var parentWindow: NSWindow?
    weak var webView: WKWebView?
    let panel: NativeFindPanel
    let searchField = NSSearchField(frame: NSRect(x: 10, y: 8, width: 220, height: 28))
    let statusLabel = NSTextField(labelWithString: "")
    private var generation = 0

    init(parentWindow: NSWindow, webView: WKWebView) {
        self.parentWindow = parentWindow
        self.webView = webView
        self.panel = NativeFindPanel(
            contentRect: NSRect(x: 0, y: 0, width: 390, height: 44),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()

        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.titlebarSeparatorStyle = .none
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.fullScreenAuxiliary]
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true

        let background = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 390, height: 44))
        background.autoresizingMask = [.width, .height]
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        panel.contentView = background

        searchField.placeholderString = "Find in Page"
        searchField.delegate = self
        searchField.target = self
        searchField.action = #selector(findNext(_:))
        searchField.sendsSearchStringImmediately = true
        background.addSubview(searchField)

        statusLabel.frame = NSRect(x: 236, y: 13, width: 62, height: 20)
        statusLabel.alignment = .right
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.lineBreakMode = .byTruncatingTail
        background.addSubview(statusLabel)

        let previous = makeButton(title: "‹", frame: NSRect(x: 304, y: 8, width: 24, height: 28), action: #selector(findPrevious(_:)))
        previous.toolTip = "Previous Match (Shift-Command-G)"
        background.addSubview(previous)

        let next = makeButton(title: "›", frame: NSRect(x: 330, y: 8, width: 24, height: 28), action: #selector(findNext(_:)))
        next.toolTip = "Next Match (Command-G)"
        background.addSubview(next)

        let close = makeButton(title: "×", frame: NSRect(x: 356, y: 8, width: 24, height: 28), action: #selector(closePanel(_:)))
        close.toolTip = "Close Find"
        background.addSubview(close)
    }

    private func makeButton(title: String, frame: NSRect, action: Selector) -> NSButton {
        let button = NSButton(title: title, target: self, action: action)
        button.frame = frame
        button.bezelStyle = .texturedRounded
        button.controlSize = .small
        button.font = .systemFont(ofSize: 16, weight: .medium)
        return button
    }

    func show(searchExistingQuery: Bool = true) {
        guard let parentWindow else { return }
        reposition()
        if panel.parent !== parentWindow {
            panel.parent?.removeChildWindow(panel)
            parentWindow.addChildWindow(panel, ordered: .above)
        }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(searchField)
        searchField.selectText(nil)
        if searchExistingQuery, !searchField.stringValue.isEmpty {
            performFind(backwards: false)
        }
    }

    func reposition() {
        guard let parentWindow else { return }
        let size = panel.frame.size
        let parentFrame = parentWindow.frame
        let topInset: CGFloat = parentWindow.styleMask.contains(.fullScreen) ? 12 : 36
        var origin = NSPoint(
            x: parentFrame.maxX - size.width - 12,
            y: parentFrame.maxY - size.height - topInset
        )
        if let visible = parentWindow.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            origin.x = max(visible.minX + 4, min(origin.x, visible.maxX - size.width - 4))
            origin.y = max(visible.minY + 4, min(origin.y, visible.maxY - size.height - 4))
        }
        panel.setFrameOrigin(origin)
    }

    @objc func findNext(_ sender: Any?) {
        performFind(backwards: false)
    }

    @objc func findPrevious(_ sender: Any?) {
        performFind(backwards: true)
    }

    @objc func closePanel(_ sender: Any?) {
        hide(restoreFocus: true)
    }

    func pageDidFinishNavigation() {
        generation += 1
        statusLabel.stringValue = ""
        if panel.isVisible, !searchField.stringValue.isEmpty {
            performFind(backwards: false)
        }
    }

    func invalidate() {
        generation += 1
        hide(restoreFocus: false)
        searchField.delegate = nil
        searchField.target = nil
        webView = nil
        parentWindow = nil
    }

    private func hide(restoreFocus: Bool) {
        if let parent = panel.parent {
            parent.removeChildWindow(panel)
        }
        panel.orderOut(nil)
        clearFindSelection()
        guard restoreFocus, let parentWindow, let webView else { return }
        parentWindow.makeKeyAndOrderFront(nil)
        parentWindow.makeFirstResponder(webView)
    }

    private func clearFindSelection() {
        guard let webView else { return }
        if #available(macOS 11.0, *) {
            let configuration = WKFindConfiguration()
            configuration.wraps = true
            webView.find("", configuration: configuration) { _ in }
        } else {
            webView.evaluateJavaScript("window.getSelection?.().removeAllRanges?.()", completionHandler: nil)
        }
    }

    private func performFind(backwards: Bool) {
        guard let webView else { return }
        let query = searchField.stringValue
        generation += 1
        let requestGeneration = generation
        guard !query.isEmpty else {
            statusLabel.stringValue = ""
            clearFindSelection()
            return
        }

        if #available(macOS 11.0, *) {
            let configuration = WKFindConfiguration()
            configuration.backwards = backwards
            configuration.caseSensitive = false
            configuration.wraps = true
            webView.find(query, configuration: configuration) { [weak self] result in
                Task { @MainActor in
                    guard let self, self.generation == requestGeneration else { return }
                    self.statusLabel.stringValue = result.matchFound ? "Match" : "No match"
                }
            }
        } else {
            let encoded = (try? JSONSerialization.data(withJSONObject: [query]))
                .flatMap { String(data: $0, encoding: .utf8) }
                .map { String($0.dropFirst().dropLast()) } ?? "\"\""
            let backwardsValue = backwards ? "true" : "false"
            let script = "window.find(\(encoded), false, \(backwardsValue), true, false, true, false)"
            webView.evaluateJavaScript(script) { [weak self] value, _ in
                Task { @MainActor in
                    guard let self, self.generation == requestGeneration else { return }
                    self.statusLabel.stringValue = (value as? Bool) == true ? "Match" : "No match"
                }
            }
        }
    }

    func controlTextDidChange(_ obj: Notification) {
        performFind(backwards: false)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            hide(restoreFocus: true)
            return true
        }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let backwards = NSApp.currentEvent?.modifierFlags.contains(.shift) == true
            performFind(backwards: backwards)
            return true
        }
        return false
    }
}

@MainActor
final class NativeMenuSelectionTarget: NSObject {
    var commandId: Int?

    @objc func select(_ sender: NSMenuItem) {
        commandId = (sender.representedObject as? NSNumber)?.intValue
    }
}

@MainActor
final class NativeDatePickerSession: NSObject, NSPopoverDelegate {
    let requestId: String
    let recordId: String
    let mode: String
    weak var host: AppDelegate?
    let popover = NSPopover()
    let picker = NSDatePicker()
    var completed = false

    init(requestId: String, recordId: String, mode: String, host: AppDelegate) {
        self.requestId = requestId
        self.recordId = recordId
        self.mode = mode
        self.host = host
        super.init()
        popover.delegate = self
    }

    @objc func accept(_ sender: Any?) {
        host?.completeNativeDatePicker(
            requestId: requestId,
            recordId: recordId,
            date: picker.dateValue,
            canceled: false
        )
    }

    @objc func cancel(_ sender: Any?) {
        host?.completeNativeDatePicker(
            requestId: requestId,
            recordId: recordId,
            date: nil,
            canceled: true
        )
    }

    func popoverDidClose(_ notification: Notification) {
        guard !completed else { return }
        host?.completeNativeDatePicker(
            requestId: requestId,
            recordId: recordId,
            date: nil,
            canceled: true
        )
    }

    func invalidate() {
        completed = true
        popover.delegate = nil
        if popover.isShown { popover.performClose(nil) }
        host = nil
    }
}


@MainActor
final class NativeChildWindowRecord {
    let id: String
    let parentId: String
    let feature: String
    let side: String
    let reference: NSRect?
    let window: NSWindow
    let webView: WKWebView
    var closed = false
    var animateOutGeneration = 0
    var completedAnimateOutGeneration: Int?

    init(id: String, parentId: String, feature: String, side: String, reference: NSRect?, window: NSWindow, webView: WKWebView) {
        self.id = id
        self.parentId = parentId
        self.feature = feature
        self.side = side
        self.reference = reference
        self.window = window
        self.webView = webView
    }

    func teardown() {
        if let glimpse = webView as? GlimpseWebView { glimpse.host = nil }
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
    }
}

// MARK: - WebView Subclass (context menu + inspector)

/// WKWebView that keeps a normal right-click menu and always exposes
/// "Inspect Element" once developer extras / isInspectable are enabled.
class GlimpseWebView: WKWebView {
    weak var host: AppDelegate?

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        augmentContextMenu(menu)
    }

    private func augmentContextMenu(_ menu: NSMenu) {
        let titles = menu.items.map { $0.title.lowercased() }
        func hasItem(containing needle: String) -> Bool {
            titles.contains { $0.contains(needle) }
        }

        // WebKit sometimes ships a sparse menu (e.g. blank HTML string pages).
        // Guarantee the usual edit actions via the first-responder chain.
        if !hasItem(containing: "copy") && !hasItem(containing: "paste") {
            if !menu.items.isEmpty {
                menu.addItem(NSMenuItem.separator())
            }
            menu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: ""))
        }

        if !hasItem(containing: "reload") {
            if !menu.items.isEmpty {
                menu.addItem(NSMenuItem.separator())
            }
            menu.addItem(NSMenuItem(title: "Reload Page", action: #selector(WKWebView.reload(_:)), keyEquivalent: ""))
        }

        // Developer tools — WebKit adds this when developerExtrasEnabled / isInspectable,
        // but some versions omit it; always provide a reliable entry.
        if !hasItem(containing: "inspect") {
            if !menu.items.isEmpty {
                menu.addItem(NSMenuItem.separator())
            }
            let inspect = NSMenuItem(
                title: "Inspect Element",
                action: #selector(AppDelegate.showWebInspector(_:)),
                keyEquivalent: ""
            )
            inspect.target = host
            menu.addItem(inspect)
        }
    }
}

// MARK: - Status Item View Controller

class StatusItemViewController: NSViewController {
    let webView: WKWebView

    init(webView: WKWebView, size: NSSize) {
        self.webView = webView
        super.init(nibName: nil, bundle: nil)
        self.preferredContentSize = size
    }

    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        view = NSView(frame: NSRect(origin: .zero, size: preferredContentSize))
        webView.frame = view.bounds
        webView.autoresizingMask = [.width, .height]
        view.addSubview(webView)
    }
}

// MARK: - Per-window record (multi-window host / dock list)

@MainActor
final class WindowRecord {
    let id: String
    var config: Config
    var window: NSWindow
    var webView: WKWebView
    /// Explicit, page-requested native glass regions rendered below the WKWebView.
    var nativeGlassViews: [String: NSView] = [:]
    var nativeDatePickerSessions: [String: NativeDatePickerSession] = [:]
    var nativeDialogRequestIds: Set<String> = []
    var nativeFindController: NativeFindController?
    /// Page-declared draggable and interactive exclusion rectangles in WebView coordinates.
    var windowDragRegions: [NSRect] = []
    var windowNoDragRegions: [NSRect] = []
    var hidden: Bool
    var cursorAnchor: String?
    var followMode: String
    var nativeThemeSource: String = "system"
    var closed: Bool = false

    init(id: String, config: Config, window: NSWindow, webView: WKWebView) {
        self.id = id
        self.config = config
        self.window = window
        self.webView = webView
        self.hidden = config.hidden
        self.cursorAnchor = config.cursorAnchor
        self.followMode = config.followMode
    }

    /// Break WebKit / AppKit retain cycles before the window finishes closing.
    /// Must run while the record is still retained (see zombieRecords).
    func teardownWebKit() {
        if let glimpse = webView as? GlimpseWebView {
            glimpse.host = nil
        }
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        // Removing the script handler is required — otherwise WKUserContentController
        // keeps a strong ref and teardown can UAF during the close autorelease drain.
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "glimpse")
        nativeFindController?.invalidate()
        nativeFindController = nil
        for view in nativeGlassViews.values { view.removeFromSuperview() }
        nativeGlassViews.removeAll()
        for session in nativeDatePickerSessions.values { session.invalidate() }
        nativeDatePickerSessions.removeAll()
        nativeDialogRequestIds.removeAll()
        windowDragRegions.removeAll()
        windowNoDragRegions.removeAll()
        webView.removeFromSuperview()
    }
}

// MARK: - AppDelegate

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, NSWindowDelegate, UNUserNotificationCenterDelegate, NSMenuItemValidation {

    var window: NSWindow!
    var webView: WKWebView!
    let config: Config

    /// Multi-window registry (Chrome-like single dock icon, many windows).
    var records: [String: WindowRecord] = [:]
    var recordOrder: [String] = []
    var nativeChildRecords: [ObjectIdentifier: NativeChildWindowRecord] = [:]
    var nativeNotificationOwners: [String: String] = [:]
    var nativeNotificationBackends: [String: String] = [:]
    var nativeNotificationShown: Set<String> = []
    var hostMode: Bool = false
    /// Keep closed records alive until the next main-queue turn so AppKit can
    /// finish windowWillClose / autorelease drains without UAF (SIGSEGV).
    var zombieRecords: [WindowRecord] = []

    /// Unix control socket listen FD (Raycast / glimpse-ctl).
    var controlListenFD: Int32 = -1
    var controlServerStarted: Bool = false
    var effectiveAppearanceObservation: NSKeyValueObservation?
    var systemColorsObserver: NSObjectProtocol?
    var windowDragMouseMonitor: Any?

    // Hidden state — tracks whether the window is hidden (prewarm mode)
    var hidden: Bool = false

    // Cursor anchor — mutable so the follow-cursor protocol command can update it at runtime
    var cursorAnchor: String? = nil

    // Follow mode — mutable so the follow-cursor protocol command can switch at runtime
    var followMode: String = "snap"

    // Mouse monitor references for follow-cursor mode
    var globalMouseMonitor: Any?
    var localMouseMonitor: Any?

    // Spring physics state
    var springTargetX: CGFloat = 0
    var springTargetY: CGFloat = 0
    var springPosX: CGFloat = 0
    var springPosY: CGFloat = 0
    var springVelX: CGFloat = 0
    var springVelY: CGFloat = 0
    var springTimer: DispatchSourceTimer? = nil
    var springTimerSuspended: Bool = true

    let springStiffness: CGFloat = 400
    let springDamping: CGFloat = 28
    let springDt: CGFloat = 1.0 / 120.0
    let springSettleThreshold: CGFloat = 0.5

    private func openURLInBrowser(_ url: URL) {
        let active = records.values.first(where: { $0.webView === webView })?.config
        let openLinks = active?.openLinks ?? config.openLinks
        let openLinksApp = active?.openLinksApp ?? config.openLinksApp
        guard openLinks else { return }

        if let appPath = openLinksApp {
            let appURL = URL(fileURLWithPath: appPath)
            guard FileManager.default.fileExists(atPath: appPath) else {
                log("open-links-app: app path not found: \(appPath)")
                _ = NSWorkspace.shared.open(url)
                return
            }

            let openConfig = NSWorkspace.OpenConfiguration()
            NSWorkspace.shared.open(
                [url],
                withApplicationAt: appURL,
                configuration: openConfig
            ) { _, error in
                if let error {
                    log("open-links-app: failed to open \(url.absoluteString) in \(appPath): \(error.localizedDescription)")
                    _ = NSWorkspace.shared.open(url)
                }
            }
        } else {
            if !NSWorkspace.shared.open(url) {
                log("open-links: failed to open \(url.absoluteString) in default browser")
            }
        }
    }

    // Status item mode
    var nsStatusItem: NSStatusItem?
    var popover: NSPopover?
    var popoverViewController: StatusItemViewController?

    nonisolated init(config: Config) {
        self.config = config
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let notificationCenter = UNUserNotificationCenter.current()
        notificationCenter.delegate = self
        let category = UNNotificationCategory(
            identifier: "GLIMPSE_NOTIFICATION",
            actions: [],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        notificationCenter.setNotificationCategories([category])

        hostMode = config.hostMode

        // AppKit routes Cmd+C/V/X/A (and undo/redo) through the main menu's
        // key equivalents. Without an Edit menu, those shortcuts never reach
        // WKWebView's first-responder chain.
        setupMainMenu()
        applyAppIcon()
        installNativeThemeObservers()
        installWindowDragMonitor()

        if config.statusItem {
            setupStatusItem()
        } else if hostMode {
            // Multi-window host: no window until {"type":"open",...}
            // Control socket is host-only (Raycast / glimpse-ctl); isolated
            // windows skip it so normal open() stays quiet.
            startControlServer()
            writeEvent(["type": "host-ready"])
        } else {
            _ = createWindowRecord(id: config.windowId, windowConfig: config)
            if config.followCursor {
                if followMode == "spring" {
                    springPosX = window.frame.origin.x
                    springPosY = window.frame.origin.y
                    let target = computeTargetPosition(mouse: NSEvent.mouseLocation)
                    springTargetX = target.x
                    springTargetY = target.y
                }
                startFollowingCursor()
            }
        }
        startStdinReader()
    }

    // MARK: - Control Socket Server

    /// Accept JSON-lines commands from Raycast / CLI:
    ///   {"type":"list"}
    ///   {"type":"focus","id":"..."}
    ///   {"type":"close","id":"..."}
    ///   {"type":"ping"}
    private func startControlServer() {
        guard !controlServerStarted else { return }
        controlServerStarted = true

        let path = controlSocketPath()
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            log("control socket: socket() failed: \(String(cString: strerror(errno)))")
            return
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxPath = MemoryLayout.size(ofValue: addr.sun_path)
        guard let pathData = path.data(using: .utf8), pathData.count < maxPath else {
            log("control socket: path too long: \(path)")
            close(fd)
            return
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: pathData)
            raw[pathData.count] = 0
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            log("control socket: bind failed: \(String(cString: strerror(errno)))")
            close(fd)
            return
        }
        guard listen(fd, 8) == 0 else {
            log("control socket: listen failed: \(String(cString: strerror(errno)))")
            close(fd)
            return
        }

        controlListenFD = fd
        // Publish PID for diagnostics
        try? "\(ProcessInfo.processInfo.processIdentifier)\n".write(
            toFile: controlPidPath(),
            atomically: true,
            encoding: .utf8
        )

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while true {
                let client = Darwin.accept(fd, nil, nil)
                if client < 0 {
                    if errno == EINTR { continue }
                    // EBADF / EINVAL / ECONNABORTED are normal when the listen
                    // FD is closed during applicationWillTerminate.
                    let err = errno
                    if err != EBADF && err != EINVAL && err != ECONNABORTED {
                        log("control socket: accept failed: \(String(cString: strerror(err)))")
                    }
                    break
                }
                // Read on background thread; only command handling is main-isolated.
                self?.handleControlClient(client)
            }
        }
    }

    nonisolated private func handleControlClient(_ clientFD: Int32) {
        // Read one JSON line (bounded).
        var buffer = Data()
        var tmp = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(clientFD, &tmp, tmp.count)
            if n <= 0 { break }
            buffer.append(contentsOf: tmp[0..<n])
            if buffer.contains(UInt8(ascii: "\n")) { break }
            if buffer.count > 64 * 1024 { break }
        }

        guard let lineData = buffer.split(separator: UInt8(ascii: "\n")).first,
              let line = String(data: Data(lineData), encoding: .utf8),
              let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else {
            writeJSONLineToFD(clientFD, ["type": "error", "message": "invalid JSON command"])
            close(clientFD)
            return
        }

        let response: [String: Any] = DispatchQueue.main.sync {
            // AppDelegate is MainActor-isolated; we are on main via sync.
            self.handleControlCommand(type: type, json: json)
        }
        writeJSONLineToFD(clientFD, response)
        Darwin.close(clientFD)
    }

    func handleControlCommand(type: String, json: [String: Any]) -> [String: Any] {
        switch type {
        case "ping":
            return [
                "type": "pong",
                "pid": ProcessInfo.processInfo.processIdentifier,
                "hostMode": hostMode,
                "windowCount": records.count,
            ]

        case "list":
            let keyWin = NSApp.keyWindow
            var windows: [[String: Any]] = []
            for id in recordOrder {
                guard let rec = records[id], !rec.closed else { continue }
                let frame = rec.window.frame
                windows.append([
                    "id": id,
                    "title": rec.window.title.isEmpty ? "Glimpse" : rec.window.title,
                    "active": rec.window === keyWin,
                    "visible": rec.window.isVisible,
                    "miniaturized": rec.window.isMiniaturized,
                    "floating": rec.config.floating,
                    "x": Int(frame.origin.x),
                    "y": Int(frame.origin.y),
                    "width": Int(frame.size.width),
                    "height": Int(frame.size.height),
                ])
            }
            return [
                "type": "list",
                "pid": ProcessInfo.processInfo.processIdentifier,
                "windows": windows,
            ]

        case "focus", "activate":
            guard let id = json["id"] as? String, let rec = records[id], !rec.closed else {
                return ["type": "error", "message": "window not found"]
            }
            if rec.window.isMiniaturized {
                rec.window.deminiaturize(nil)
            }
            activateRecord(rec)
            return ["type": "ok", "id": id, "action": "focus"]

        case "close":
            guard let id = json["id"] as? String, let rec = records[id], !rec.closed else {
                return ["type": "error", "message": "window not found"]
            }
            closeRecord(rec, userInitiated: true)
            return ["type": "ok", "id": id, "action": "close"]

        default:
            return ["type": "error", "message": "unknown command: \(type)"]
        }
    }

    /// Do NOT re-list windows here. AppKit already injects the open-window list
    /// (with the active checkmark) into the Dock menu; returning another copy
    /// produces the "shown twice" bug (system list + custom list).
    /// Return nil so Dock shows the single system window list + standard items.
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        nil
    }

    private func applyAppIcon() {
        if let image = loadAppIconImage() {
            // Prefer full-bleed bitmap; Dock applies the squircle mask itself.
            NSApp.applicationIconImage = image
        }
    }

    private func recordId(for window: NSWindow?) -> String? {
        guard let window else { return nil }
        return records.first(where: { $0.value.window === window })?.key
    }

    private func record(forWebView webView: WKWebView) -> WindowRecord? {
        records.values.first(where: { $0.webView === webView })
    }

    private func nativeChild(forWebView webView: WKWebView) -> NativeChildWindowRecord? {
        nativeChildRecords[ObjectIdentifier(webView)]
    }

    private func closeNativeChild(_ child: NativeChildWindowRecord) {
        guard !child.closed else { return }
        child.closed = true
        child.animateOutGeneration += 1
        nativeChildRecords.removeValue(forKey: ObjectIdentifier(child.webView))
        records[child.parentId]?.window.removeChildWindow(child.window)
        child.teardown()
        child.window.orderOut(nil)
        child.window.close()
    }

    private func animateOutNativeChild(_ child: NativeChildWindowRecord) {
        guard child.feature == "tooltip", !child.closed else { return }
        child.animateOutGeneration += 1
        let generation = child.animateOutGeneration
        child.completedAnimateOutGeneration = nil
        child.window.alphaValue = 1
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            child.window.animator().alphaValue = 0
        } completionHandler: { [weak child] in
            Task { @MainActor in
                guard let child,
                      !child.closed,
                      child.animateOutGeneration == generation,
                      child.completedAnimateOutGeneration != generation else { return }
                child.completedAnimateOutGeneration = generation
                _ = try? await child.webView.evaluateJavaScript("window.onAnimateOutComplete?.()")
            }
        }
    }

    private func cancelAnimateOutNativeChild(_ child: NativeChildWindowRecord) {
        guard child.feature == "tooltip", !child.closed else { return }
        child.animateOutGeneration += 1
        child.completedAnimateOutGeneration = nil
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            child.window.animator().alphaValue = 1
        }
    }

    private func closeNativeChildren(parentId: String) {
        let children = nativeChildRecords.values.filter { $0.parentId == parentId }
        for child in children { closeNativeChild(child) }
    }

    private func positionNativeChild(_ child: NativeChildWindowRecord, size: NSSize) {
        guard let parent = records[child.parentId], let reference = child.reference else { return }
        let webHeight = parent.webView.bounds.height
        let webY = parent.webView.isFlipped ? reference.origin.y : webHeight - reference.origin.y - reference.height
        let webRect = NSRect(x: reference.origin.x, y: webY, width: reference.width, height: reference.height)
        let windowRect = parent.webView.convert(webRect, to: nil)
        let screenRect = parent.window.convertToScreen(windowRect)
        let gap: CGFloat = 6
        var origin: NSPoint
        switch child.side {
        case "bottom": origin = NSPoint(x: screenRect.midX - size.width / 2, y: screenRect.minY - size.height - gap)
        case "left": origin = NSPoint(x: screenRect.minX - size.width - gap, y: screenRect.midY - size.height / 2)
        case "right": origin = NSPoint(x: screenRect.maxX + gap, y: screenRect.midY - size.height / 2)
        default: origin = NSPoint(x: screenRect.midX - size.width / 2, y: screenRect.maxY + gap)
        }
        if let visible = parent.window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            origin.x = max(visible.minX, min(origin.x, visible.maxX - size.width))
            origin.y = max(visible.minY, min(origin.y, visible.maxY - size.height))
        }
        child.window.setFrame(NSRect(origin: origin, size: size), display: true)
        child.window.orderFrontRegardless()
    }

    private func resizeNativeChild(_ request: [String: Any], child: NativeChildWindowRecord) {
        guard let widthValue = request["width"] as? NSNumber,
              let heightValue = request["height"] as? NSNumber else { return }
        let width = CGFloat(truncating: widthValue)
        let height = CGFloat(truncating: heightValue)
        guard width.isFinite, height.isFinite, width >= 1, height >= 1, width <= 1600, height <= 1200 else { return }
        let size = NSSize(width: ceil(width), height: ceil(height))
        child.window.setContentSize(size)
        positionNativeChild(child, size: size)
    }

    private func isStandardWindowButtonHit(_ point: NSPoint, in window: NSWindow) -> Bool {
        let buttonTypes: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        return buttonTypes.contains { type in
            guard let button = window.standardWindowButton(type), !button.isHidden else { return false }
            // Local event monitors run before AppKit dispatches the click to the titlebar.
            // Convert the real button bounds into window coordinates and include a small
            // tolerance so clicks on the visible rim are never mistaken for window drag.
            let hitRect = button.convert(button.bounds, to: nil).insetBy(dx: -4, dy: -4)
            return hitRect.contains(point)
        }
    }

    func shouldPerformWindowDrag(windowIdentity: UInt, locationInWindow: NSPoint) -> Bool {
        guard let rec = records.values.first(where: {
            UInt(bitPattern: Unmanaged.passUnretained($0.window).toOpaque()) == windowIdentity
        }), !rec.closed, !rec.config.clickThrough else { return false }
        if isStandardWindowButtonHit(locationInWindow, in: rec.window) { return false }
        let point = rec.webView.convert(locationInWindow, from: nil)
        if rec.windowNoDragRegions.contains(where: { $0.contains(point) }) { return false }
        return rec.windowDragRegions.contains(where: { $0.contains(point) })
    }

    private func resolveRecord(from json: [String: Any]) -> WindowRecord? {
        if let id = json["id"] as? String {
            return records[id]
        }
        // Prefer key window's record, then last created.
        if let keyId = recordId(for: NSApp.keyWindow), let rec = records[keyId] {
            return rec
        }
        if let last = recordOrder.last, let rec = records[last] {
            return rec
        }
        return records.values.first
    }

    private func resolveContentTarget(from json: [String: Any]) -> (webView: WKWebView, record: WindowRecord?)? {
        if config.statusItem, let webView {
            return (webView, nil)
        }
        guard let record = resolveRecord(from: json) else { return nil }
        return (record.webView, record)
    }

    private func bindActive(from rec: WindowRecord) {
        window = rec.window
        webView = rec.webView
        hidden = rec.hidden
        cursorAnchor = rec.cursorAnchor
        followMode = rec.followMode
    }

    private func dispatchWindowFocus(_ focused: Bool, to webView: WKWebView) {
        let value = focused ? "true" : "false"
        webView.evaluateJavaScript("window.__GAPP_SET_WINDOW_FOCUS__?.(\(value))", completionHandler: nil)
    }

    private func activateRecord(_ rec: WindowRecord) {
        bindActive(from: rec)
        rec.hidden = false
        hidden = false
        if !rec.config.clickThrough {
            NSApp.setActivationPolicy(.regular)
        }
        rec.window.makeKeyAndOrderFront(nil)
        rec.window.makeFirstResponder(rec.webView)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Create a new managed window and register it for the dock menu.
    @discardableResult
    func createWindowRecord(id: String, windowConfig: Config) -> WindowRecord {
        // Build window + webview using temporary config fields via helpers
        let built = buildWindowAndWebView(windowConfig: windowConfig)
        let rec = WindowRecord(id: id, config: windowConfig, window: built.window, webView: built.webView)
        records[id] = rec
        recordOrder.append(id)
        bindActive(from: rec)

        // Associate webview → host for context-menu inspector
        if let gv = built.webView as? GlimpseWebView {
            gv.host = self
        }

        if windowConfig.followCursor {
            if windowConfig.followMode == "spring" {
                springPosX = rec.window.frame.origin.x
                springPosY = rec.window.frame.origin.y
                let target = computeTargetPosition(mouse: NSEvent.mouseLocation)
                springTargetX = target.x
                springTargetY = target.y
            }
            startFollowingCursor()
        }

        return rec
    }

    private func buildWindowAndWebView(windowConfig: Config) -> (window: NSWindow, webView: WKWebView) {
        let rect = NSRect(x: 0, y: 0, width: windowConfig.width, height: windowConfig.height)
        var styleMask: NSWindow.StyleMask = windowConfig.frameless
            ? [.borderless]
            : [.titled, .closable, .miniaturizable, .resizable]
        if !windowConfig.frameless && windowConfig.transparent {
            styleMask.insert(.fullSizeContentView)
        }
        let win = GlimpsePanel(
            contentRect: rect,
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )
        win.title = windowConfig.title
        // WKWebView hover states require the host window to receive mouse-moved events.
        win.acceptsMouseMovedEvents = true
        if !windowConfig.frameless && windowConfig.transparent {
            win.titlebarAppearsTransparent = true
            win.titleVisibility = .hidden
            win.titlebarSeparatorStyle = .none

            // Glaze's framed WebView windows use unified toolbar geometry even when
            // the toolbar has no items. This keeps native traffic lights at the
            // Glaze default inset while the full-size WebView remains underneath.
            let toolbar = NSToolbar(identifier: NSToolbar.Identifier("glimpse.transparent.\(UUID().uuidString)"))
            toolbar.allowsUserCustomization = false
            toolbar.autosavesConfiguration = false
            win.toolbarStyle = .unified
            win.toolbar = toolbar
        }
        if windowConfig.frameless {
            win.isMovableByWindowBackground = true
        }
        if windowConfig.floating || windowConfig.followCursor {
            win.level = .floating
        }
        if windowConfig.clickThrough {
            win.ignoresMouseEvents = true
        }
        if windowConfig.transparent {
            win.isOpaque = false
            win.backgroundColor = .clear
        }
        if windowConfig.followCursor {
            let mouse = NSEvent.mouseLocation
            if let anchor = windowConfig.cursorAnchor,
               let base = anchorPosition(mouse: mouse, windowSize: NSSize(width: windowConfig.width, height: windowConfig.height), anchor: anchor) {
                let x = base.x + CGFloat(windowConfig.cursorOffsetX)
                let y = base.y + CGFloat(windowConfig.cursorOffsetY)
                win.setFrameOrigin(NSPoint(x: x, y: y))
            } else {
                let x = mouse.x + CGFloat(windowConfig.cursorOffsetX)
                let y = mouse.y + CGFloat(windowConfig.cursorOffsetY)
                win.setFrameOrigin(NSPoint(x: x, y: y))
            }
        } else if let x = windowConfig.x, let y = windowConfig.y {
            win.setFrameOrigin(NSPoint(x: x, y: y))
        } else {
            win.center()
        }
        win.delegate = self
        // We own lifetime via WindowRecord. AppKit's default released-when-closed
        // races with Swift ARC and causes EXC_BAD_ACCESS on close.
        win.isReleasedWhenClosed = false

        let view = installWebView(frame: win.contentView!.bounds, windowConfig: windowConfig)
        view.autoresizingMask = [.width, .height]
        win.contentView?.addSubview(view)
        view.loadHTMLString("<html><body></body></html>", baseURL: nil)

        if windowConfig.hidden {
            win.orderOut(nil)
        } else if windowConfig.clickThrough {
            win.orderFrontRegardless()
        } else {
            win.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        return (win, view)
    }

    // MARK: - Setup

    /// Install a minimal main menu so standard edit shortcuts work in the WebView.
    /// macOS does not deliver Cmd+C/V/X/A as raw key events to the responder chain
    /// unless matching menu items exist — this is required even for "menu-less" tools.
    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // Application menu (first item is always the app menu)
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide \(config.title)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit \(config.title)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit — required for cut/copy/paste/select-all/undo/redo key equivalents
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(NSMenuItem.separator())
        let findItem = editMenu.addItem(withTitle: "Find…", action: #selector(showFindPanel(_:)), keyEquivalent: "f")
        findItem.target = self
        let findNextItem = editMenu.addItem(withTitle: "Find Next", action: #selector(findNextInPage(_:)), keyEquivalent: "g")
        findNextItem.target = self
        let findPreviousItem = editMenu.addItem(withTitle: "Find Previous", action: #selector(findPreviousInPage(_:)), keyEquivalent: "g")
        findPreviousItem.keyEquivalentModifierMask = [.command, .shift]
        findPreviousItem.target = self
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View — reload + Web Inspector (developer tools)
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload Page", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        let inspectItem = viewMenu.addItem(
            withTitle: "Show Web Inspector",
            action: #selector(showWebInspector(_:)),
            keyEquivalent: "i"
        )
        inspectItem.keyEquivalentModifierMask = [.command, .option]
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Window — Cmd+W close is expected in macOS apps
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    /// Enable Web Inspector / "Inspect Element" for a WKWebView.
    private func enableWebViewInspection(_ webView: WKWebView) {
        // Public API (macOS 13.3+): required for inspectability of non-App-Store debug flows
        // and for the system "Inspect Element" context item on modern macOS.
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }
        // Legacy WebKit preference — still drives context-menu developer extras
        // on some OS versions and is harmless alongside isInspectable.
        webView.configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
    }

    @objc func reloadPage(_ sender: Any?) {
        webView?.reload()
    }

    private func activeFindRecord() -> WindowRecord? {
        if let keyWindow = NSApp.keyWindow {
            if let record = records.values.first(where: { $0.window === keyWindow }) {
                return record
            }
            if let record = records.values.first(where: { $0.nativeFindController?.panel === keyWindow }) {
                return record
            }
        }
        if let webView, let record = record(forWebView: webView) {
            return record
        }
        if let last = recordOrder.last {
            return records[last]
        }
        return nil
    }

    private func findController(for record: WindowRecord) -> NativeFindController? {
        guard record.config.findInPage, !record.config.clickThrough, !record.closed else { return nil }
        if let existing = record.nativeFindController { return existing }
        let controller = NativeFindController(parentWindow: record.window, webView: record.webView)
        record.nativeFindController = controller
        return controller
    }

    @objc func showFindPanel(_ sender: Any?) {
        guard let record = activeFindRecord(), let controller = findController(for: record) else { return }
        bindActive(from: record)
        controller.show()
    }

    @objc func findNextInPage(_ sender: Any?) {
        guard let record = activeFindRecord(), let controller = findController(for: record) else { return }
        bindActive(from: record)
        controller.show(searchExistingQuery: false)
        controller.findNext(sender)
    }

    @objc func findPreviousInPage(_ sender: Any?) {
        guard let record = activeFindRecord(), let controller = findController(for: record) else { return }
        bindActive(from: record)
        controller.show(searchExistingQuery: false)
        controller.findPrevious(sender)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(showFindPanel(_:)) ||
           menuItem.action == #selector(findNextInPage(_:)) ||
           menuItem.action == #selector(findPreviousInPage(_:)) {
            guard let record = activeFindRecord() else { return false }
            return record.config.findInPage && !record.config.clickThrough && !record.closed
        }
        return true
    }

    /// Open Web Inspector (menu + context-menu entry). Uses public inspectability
    /// plus best-effort SPI show methods across WebKit versions.
    @objc func showWebInspector(_ sender: Any?) {
        guard let webView else { return }
        enableWebViewInspection(webView)

        if Self.tryShowWebInspector(on: webView) {
            return
        }

        // Fallback: inspector is available via right-click → Inspect Element
        // once isInspectable / developerExtrasEnabled are set.
        log("Web Inspector enabled — right-click the page and choose Inspect Element (or use View menu)")
    }

    /// Best-effort open of WebKit's Web Inspector without hard-linking private headers.
    /// Returns true if a show path was invoked.
    ///
    /// On current macOS WebKit the reliable path is:
    /// `webView._inspector` (`_WKInspector`) → `show()` / `showConsole()`.
    private static func tryShowWebInspector(on webView: WKWebView) -> Bool {
        // Private `_WKInspector` via getter (selector-based; no private KVC keys).
        let getSel = NSSelectorFromString("_inspector")
        if webView.responds(to: getSel), let unmanaged = webView.perform(getSel) {
            let inspector = unmanaged.takeUnretainedValue()
            for name in ["show", "showConsole"] {
                let sel = NSSelectorFromString(name)
                if inspector.responds(to: sel) {
                    _ = inspector.perform(sel)
                    return true
                }
            }
        }

        // Older / alternate SPI entry points
        for name in ["_showWebViewInspector", "showWebViewInspector", "_showInspector"] {
            let sel = NSSelectorFromString(name)
            if webView.responds(to: sel) {
                _ = webView.perform(sel)
                return true
            }
        }

        return false
    }

    private func makeWebViewConfiguration() -> WKWebViewConfiguration {
        let ucc = WKUserContentController()
        let script = WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        ucc.addUserScript(script)
        ucc.add(self, name: "glimpse")
        let wkConfig = WKWebViewConfiguration()
        wkConfig.userContentController = ucc
        // Enable developer extras early so WebKit installs Inspect Element in context menus.
        wkConfig.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // Glaze enables WebKit's system appearance preference before creating the
        // WKWebView. This is the exact gate for private -apple-visual-effect CSS
        // materials such as -apple-system-glass-material on macOS 26+.
        let useSystemAppearance = NSSelectorFromString("_setUseSystemAppearance:")
        if wkConfig.preferences.responds(to: useSystemAppearance) {
            typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
            let setter = unsafeBitCast(
                wkConfig.preferences.method(for: useSystemAppearance),
                to: Setter.self
            )
            setter(wkConfig.preferences, useSystemAppearance, true)
        }
        return wkConfig
    }

    private func installWebView(frame: NSRect, windowConfig: Config? = nil) -> GlimpseWebView {
        let cfg = windowConfig ?? config
        let view = GlimpseWebView(frame: frame, configuration: makeWebViewConfiguration())
        view.host = self
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        view.uiDelegate = self
        enableWebViewInspection(view)
        if cfg.transparent {
            view.underPageBackgroundColor = .clear
            view.setValue(false, forKey: "drawsBackground")
        }
        return view
    }

    // MARK: - Status Item

    private func setupStatusItem() {
        log("Setting up status item mode")

        let size = NSSize(width: config.width, height: config.height)
        let view = installWebView(frame: NSRect(origin: .zero, size: size), windowConfig: config)
        webView = view

        // Create view controller and popover
        popoverViewController = StatusItemViewController(webView: webView, size: size)

        popover = NSPopover()
        popover!.contentViewController = popoverViewController
        popover!.contentSize = size
        popover!.behavior = .transient

        // Create status bar item
        nsStatusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = nsStatusItem?.button {
            button.title = config.title == "Glimpse" ? "G" : config.title
            button.action = #selector(statusItemClicked(_:))
            button.target = self
        }

        // Load blank page to trigger first ready
        webView.loadHTMLString("<html><body></body></html>", baseURL: nil)
    }

    @objc func statusItemClicked(_ sender: Any?) {
        guard let button = nsStatusItem?.button, let popover = popover else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        writeToStdout(["type": "click"])
    }

    // MARK: - Follow Cursor

    func computeTargetPosition(mouse: NSPoint) -> NSPoint {
        let activeCfg = records.values.first(where: { $0.window === window })?.config ?? config
        let ox = CGFloat(activeCfg.cursorOffsetX)
        let oy = CGFloat(activeCfg.cursorOffsetY)
        if let anchor = cursorAnchor,
           let base = anchorPosition(mouse: mouse, windowSize: window.frame.size, anchor: anchor) {
            return NSPoint(x: base.x + ox, y: base.y + oy)
        } else {
            return NSPoint(x: mouse.x + ox, y: mouse.y + oy)
        }
    }

    func startFollowingCursor() {
        guard globalMouseMonitor == nil else { return }
        window.level = .floating
        let moveHandler: (NSEvent) -> Void = { [weak self] _ in
            guard let self else { return }
            let target = self.computeTargetPosition(mouse: NSEvent.mouseLocation)
            if self.followMode == "spring" {
                self.springTargetX = target.x
                self.springTargetY = target.y
                self.wakeSpringTimer()
            } else {
                self.window.setFrameOrigin(target)
            }
        }
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged],
            handler: moveHandler
        )
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
            guard let self else { return event }
            let target = self.computeTargetPosition(mouse: NSEvent.mouseLocation)
            if self.followMode == "spring" {
                self.springTargetX = target.x
                self.springTargetY = target.y
                self.wakeSpringTimer()
            } else {
                self.window.setFrameOrigin(target)
            }
            return event
        }
    }

    func wakeSpringTimer() {
        if springTimer == nil {
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now(), repeating: .milliseconds(8))
            timer.setEventHandler { [weak self] in
                MainActor.assumeIsolated {
                    self?.springPhysicsStep()
                }
            }
            springTimer = timer
            springTimerSuspended = true  // newly created timers are suspended
        }
        if springTimerSuspended {
            springTimer!.resume()
            springTimerSuspended = false
        }
    }

    func springPhysicsStep() {
        let dx = springTargetX - springPosX
        let dy = springTargetY - springPosY
        let fx = springStiffness * dx - springDamping * springVelX
        let fy = springStiffness * dy - springDamping * springVelY
        springVelX += fx * springDt
        springVelY += fy * springDt
        springPosX += springVelX * springDt
        springPosY += springVelY * springDt
        window.setFrameOrigin(NSPoint(x: springPosX, y: springPosY))

        // Suspend timer when settled (zero CPU at rest)
        let dist = (dx * dx + dy * dy).squareRoot()
        let vel = (springVelX * springVelX + springVelY * springVelY).squareRoot()
        if dist < springSettleThreshold && vel < springSettleThreshold {
            springPosX = springTargetX
            springPosY = springTargetY
            springVelX = 0
            springVelY = 0
            window.setFrameOrigin(NSPoint(x: springPosX, y: springPosY))
            if !springTimerSuspended {
                springTimer?.suspend()
                springTimerSuspended = true
            }
        }
    }

    func computeCursorTip() -> [String: Int]? {
        let H = window.frame.size.height
        if let anchor = cursorAnchor,
           let base = anchorPosition(mouse: NSPoint(x: 0, y: 0), windowSize: window.frame.size, anchor: anchor) {
            // In anchor mode, the offset from mouse to window origin is constant.
            // base is computed with mouse at (0,0), so base.x/y IS the offset from mouse to window origin.
            let cssX = 0 - base.x - CGFloat(config.cursorOffsetX)
            let cssY = H - (0 - base.y - CGFloat(config.cursorOffsetY))
            return ["x": Int(cssX), "y": Int(cssY)]
        } else if config.followCursor || globalMouseMonitor != nil {
            // Offset-only mode: windowOrigin.x = mouse.x + offsetX, windowOrigin.y = mouse.y + offsetY
            // cssX = mouse.x - windowOrigin.x = -offsetX
            // cssY = H - (mouse.y - windowOrigin.y) = H - (-offsetY) = H + offsetY
            let cssX = -config.cursorOffsetX
            let cssY = Int(H) + config.cursorOffsetY
            return ["x": cssX, "y": cssY]
        }
        return nil
    }

    func stopFollowingCursor() {
        if let monitor = globalMouseMonitor {
            NSEvent.removeMonitor(monitor)
            globalMouseMonitor = nil
        }
        if let monitor = localMouseMonitor {
            NSEvent.removeMonitor(monitor)
            localMouseMonitor = nil
        }
        // Cancel spring timer — must resume before cancel if suspended
        if let timer = springTimer {
            if springTimerSuspended {
                timer.resume()
            }
            timer.cancel()
            springTimer = nil
            springTimerSuspended = true
        }
    }

    // MARK: - Stdin Reader

    private func startStdinReader() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { continue }
                guard let data = trimmed.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let type = json["type"] as? String
                else {
                    log("Skipping invalid JSON: \(trimmed)")
                    continue
                }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self?.handleCommand(type: type, json: json)
                    }
                }
            }
            // stdin EOF — close window
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.closeAndExit()
                }
            }
        }
    }

    // MARK: - Command Dispatch

    func handleCommand(type: String, json: [String: Any]) {
        switch type {
        case "open":
            // Multi-window host: create a new window
            guard hostMode || !records.isEmpty || !config.statusItem else {
                log("open command ignored in status-item mode")
                return
            }
            let id = (json["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            if records[id] != nil {
                log("open command: window id already exists: \(id)")
                return
            }
            let windowConfig = configFromOpenCommand(json, defaults: config)
            hostMode = true
            if !windowConfig.clickThrough && !windowConfig.hidden {
                NSApp.setActivationPolicy(.regular)
            }
            _ = createWindowRecord(id: id, windowConfig: windowConfig)
            // Optional inline HTML (normally Node waits for blank ready then sends html).
            if let base64 = json["html"] as? String,
               let htmlData = Data(base64Encoded: base64),
               let html = String(data: htmlData, encoding: .utf8),
               let rec = records[id] {
                rec.webView.loadHTMLString(html, baseURL: nil)
            }
            return

        case "html":
            guard let base64 = json["html"] as? String,
                  let htmlData = Data(base64Encoded: base64),
                  let html = String(data: htmlData, encoding: .utf8)
            else {
                log("html command: missing or invalid base64 payload")
                return
            }
            guard let target = resolveContentTarget(from: json) else {
                log("html command: no target window")
                return
            }
            if let record = target.record { bindActive(from: record) }
            target.webView.loadHTMLString(html, baseURL: nil)

        case "eval":
            guard let js = json["js"] as? String else {
                log("eval command: missing js field")
                return
            }
            guard let target = resolveContentTarget(from: json) else {
                log("eval command: no target window")
                return
            }
            if let record = target.record { bindActive(from: record) }
            target.webView.evaluateJavaScript(js, completionHandler: nil)

        case "follow-cursor":
            guard !config.statusItem else {
                log("follow-cursor not supported in status-item mode")
                return
            }
            guard let rec = resolveRecord(from: json) else {
                log("follow-cursor: no target window")
                return
            }
            bindActive(from: rec)
            let enabled = json["enabled"] as? Bool ?? true
            if let anchor = json["anchor"] as? String, !anchor.isEmpty {
                cursorAnchor = anchor
                rec.cursorAnchor = anchor
            } else if json.keys.contains("anchor") {
                cursorAnchor = nil
                rec.cursorAnchor = nil
            }
            if let mode = json["mode"] as? String {
                let wasSpring = followMode == "spring"
                followMode = mode
                rec.followMode = mode
                if mode == "spring" && !wasSpring {
                    springPosX = window.frame.origin.x
                    springPosY = window.frame.origin.y
                    springVelX = 0
                    springVelY = 0
                    let target = computeTargetPosition(mouse: NSEvent.mouseLocation)
                    springTargetX = target.x
                    springTargetY = target.y
                    if globalMouseMonitor != nil { wakeSpringTimer() }
                } else if mode == "snap" && wasSpring {
                    springPosX = springTargetX
                    springPosY = springTargetY
                    springVelX = 0
                    springVelY = 0
                    window.setFrameOrigin(NSPoint(x: springPosX, y: springPosY))
                    if let timer = springTimer, !springTimerSuspended {
                        timer.suspend()
                        springTimerSuspended = true
                    }
                }
            }
            if enabled {
                startFollowingCursor()
            } else {
                stopFollowingCursor()
            }
            if let tip = computeCursorTip() {
                webView.evaluateJavaScript("window.glimpse.cursorTip = {x: \(tip["x"]!), y: \(tip["y"]!)}", completionHandler: nil)
            } else {
                webView.evaluateJavaScript("window.glimpse.cursorTip = null", completionHandler: nil)
            }

        case "file":
            guard let path = json["path"] as? String else {
                log("file command: missing path field")
                return
            }
            guard let target = resolveContentTarget(from: json) else {
                log("file command: no target window")
                return
            }
            let fileURL = URL(fileURLWithPath: path)
            guard FileManager.default.fileExists(atPath: path) else {
                log("file command: file not found: \(path)")
                return
            }
            if let record = target.record { bindActive(from: record) }
            target.webView.loadFileURL(fileURL, allowingReadAccessTo: fileURL.deletingLastPathComponent())

        case "get-info":
            let rec = resolveRecord(from: json)
            if let rec { bindActive(from: rec) }
            var info = getSystemInfo()
            info["type"] = "info"
            if !config.statusItem, window != nil, let tip = computeCursorTip() {
                info["cursorTip"] = tip
            }
            writeEvent(info, id: rec?.id)

        case "show":
            if config.statusItem {
                if let title = json["title"] as? String {
                    nsStatusItem?.button?.title = title
                }
                if let button = nsStatusItem?.button, let popover = popover, !popover.isShown {
                    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                }
            } else {
                guard let rec = resolveRecord(from: json) else {
                    log("show command: no target window")
                    return
                }
                if let title = json["title"] as? String {
                    rec.window.title = title
                }
                activateRecord(rec)
            }

        case "title":
            guard let title = json["title"] as? String else {
                log("title command: missing title field")
                return
            }
            if config.statusItem {
                nsStatusItem?.button?.title = title
            } else if let rec = resolveRecord(from: json) {
                rec.window.title = title
            }

        case "resize":
            let w = json["width"] as? Int ?? config.width
            let h = json["height"] as? Int ?? config.height
            let size = NSSize(width: w, height: h)
            if config.statusItem {
                popover?.contentSize = size
                popoverViewController?.preferredContentSize = size
            } else if let rec = resolveRecord(from: json) {
                rec.window.setContentSize(size)
            }

        case "close":
            if config.statusItem {
                closeAndExit()
            } else if let rec = resolveRecord(from: json) {
                closeRecord(rec, userInitiated: true)
            } else {
                closeAndExit()
            }

        case "quit":
            closeAndExit()

        default:
            log("Unknown command type: \(type)")
        }
    }

    func closeRecord(_ rec: WindowRecord, userInitiated: Bool) {
        guard !rec.closed else { return }
        rec.closed = true
        records.removeValue(forKey: rec.id)
        recordOrder.removeAll { $0 == rec.id }
        writeEvent(["type": "closed"], id: rec.id)

        // If this was the active window, clear dangling pointers before teardown.
        let wasActive = (window === rec.window) || (webView === rec.webView)
        if wasActive {
            window = nil
            webView = nil
        }

        // Stop routing notification events to a window that is being torn down.
        let closingNotificationIds = nativeNotificationOwners.compactMap { $0.value == rec.id ? $0.key : nil }
        nativeNotificationOwners = nativeNotificationOwners.filter { $0.value != rec.id }
        for id in closingNotificationIds {
            nativeNotificationBackends.removeValue(forKey: id)
            nativeNotificationShown.remove(id)
        }

        // Close transient native children before tearing down the parent WebView.
        closeNativeChildren(parentId: rec.id)

        // Tear down WebKit first while `rec` is still strongly held.
        rec.teardownWebKit()
        rec.window.delegate = nil
        rec.window.contentView = nil

        // Only programmatically close when the host requested it — if this was
        // triggered by windowWillClose, the window is already closing.
        if userInitiated {
            rec.window.orderOut(nil)
            rec.window.close()
        }

        // Pin the record across the current autorelease pool / close cycle.
        // Dropping it synchronously here is what caused SIGSEGV in objc_release
        // when closing one of multiple windows (entire host died → all windows gone).
        zombieRecords.append(rec)
        let zombieId = rec.id
        DispatchQueue.main.async { [weak self] in
            self?.zombieRecords.removeAll { $0.id == zombieId }
        }

        if records.isEmpty {
            // Last window closed — exit so the Dock tile disappears.
            // Shared host is re-spawned by Node on the next open().
            DispatchQueue.main.async {
                // terminate runs applicationWillTerminate (control socket cleanup).
                NSApp.terminate(nil)
            }
        } else if wasActive, let nextId = recordOrder.last, let next = records[nextId] {
            bindActive(from: next)
            // Don't force-activate remaining windows; just keep pointers consistent.
        }
    }

    func closeAndExit() {
        if config.statusItem, let item = nsStatusItem {
            NSStatusBar.system.removeStatusItem(item)
            nsStatusItem = nil
            writeEvent(["type": "closed"])
            exit(0)
        }
        // Close all windows then exit
        let all = Array(records.values)
        for rec in all {
            guard !rec.closed else { continue }
            rec.closed = true
            writeEvent(["type": "closed"], id: rec.id)
            rec.teardownWebKit()
            rec.window.delegate = nil
            rec.window.contentView = nil
            rec.window.orderOut(nil)
            rec.window.close()
        }
        records.removeAll()
        recordOrder.removeAll()
        zombieRecords.removeAll()
        window = nil
        webView = nil
        if !config.statusItem && all.isEmpty {
            writeEvent(["type": "closed"])
        }
        // Defer exit so teardown autoreleases drain cleanly.
        DispatchQueue.main.async {
            exit(0)
        }
    }

    /// Terminate when the last window closes so the Dock icon is removed.
    /// Node re-spawns the shared host on the next open() if needed.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // statusItem mode is menu-bar only; don't quit just because a popover window closed.
        if config.statusItem { return false }
        return records.isEmpty
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let windowDragMouseMonitor {
            NSEvent.removeMonitor(windowDragMouseMonitor)
            self.windowDragMouseMonitor = nil
        }
        effectiveAppearanceObservation?.invalidate()
        effectiveAppearanceObservation = nil
        if let systemColorsObserver {
            NotificationCenter.default.removeObserver(systemColorsObserver)
            self.systemColorsObserver = nil
        }
        if controlListenFD >= 0 {
            close(controlListenFD)
            controlListenFD = -1
        }
        unlink(controlSocketPath())
        try? FileManager.default.removeItem(atPath: controlPidPath())
    }

    // MARK: - WKNavigationDelegate

    nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        MainActor.assumeIsolated {
            let rec = self.record(forWebView: webView)
            let openLinks = rec?.config.openLinks ?? self.config.openLinks
            guard openLinks else {
                decisionHandler(.allow)
                return
            }

            guard navigationAction.navigationType == .linkActivated else {
                decisionHandler(.allow)
                return
            }

            guard let url = navigationAction.request.url,
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https"
            else {
                decisionHandler(.allow)
                return
            }

            // Temporarily prefer this record's open-links app settings
            if let rec {
                self.bindActive(from: rec)
            }
            openURLInBrowser(url)
            decisionHandler(.cancel)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated {
            let rec = self.record(forWebView: webView)
            if let rec {
                self.bindActive(from: rec)
                rec.nativeFindController?.pageDidFinishNavigation()
            }
            if !config.statusItem, let rec {
                if rec.hidden {
                    // WKWebView loading can implicitly order the window in.
                    rec.window.orderOut(nil)
                } else {
                    rec.window.makeFirstResponder(webView)
                }
                dispatchWindowFocus(rec.window.isKeyWindow, to: rec.webView)
            }
            var info = getSystemInfo()
            info["type"] = "ready"
            if !config.statusItem, window != nil, let tip = computeCursorTip() {
                info["cursorTip"] = tip
                webView.evaluateJavaScript("window.glimpse.cursorTip = {x: \(tip["x"]!), y: \(tip["y"]!)}", completionHandler: nil)
            }
            writeEvent(info, id: rec?.id)
        }
    }

    // MARK: - Native Glass Regions

    /// Render explicitly requested macOS glass regions below the transparent WKWebView.
    /// The page keeps ownership of text, icons, hit testing, focus and accessibility.
    private func updateNativeGlass(_ rawRegions: [[String: Any]], for rec: WindowRecord) {
        guard #available(macOS 26.0, *),
              let contentView = rec.window.contentView else {
            for view in rec.nativeGlassViews.values { view.removeFromSuperview() }
            rec.nativeGlassViews.removeAll()
            publishNativeGlassState(supported: false, ids: [], to: rec.webView)
            return
        }

        func number(_ raw: [String: Any], _ key: String) -> CGFloat? {
            guard let value = raw[key] as? NSNumber else { return nil }
            let result = CGFloat(truncating: value)
            return result.isFinite ? result : nil
        }

        var retained = Set<String>()
        let webHeight = rec.webView.bounds.height
        for raw in rawRegions.prefix(32) {
            guard let id = raw["id"] as? String, !id.isEmpty, id.count <= 128,
                  let x = number(raw, "x"), let y = number(raw, "y"),
                  let width = number(raw, "width"), let height = number(raw, "height"),
                  width > 0, height > 0, width <= 4096, height <= 4096 else { continue }

            let glass: NSGlassEffectView
            if let existing = rec.nativeGlassViews[id] as? NSGlassEffectView {
                glass = existing
            } else {
                glass = NSGlassEffectView(frame: .zero)
                glass.identifier = NSUserInterfaceItemIdentifier("glimpse.native-glass.\(id)")
                rec.nativeGlassViews[id] = glass
                contentView.addSubview(glass, positioned: .below, relativeTo: rec.webView)
            }

            // JavaScript DOMRect uses a top-left origin. WKWebView is flipped on
            // current macOS, while a generic NSView may not be; convert exactly once.
            let webY = rec.webView.isFlipped ? y : webHeight - y - height
            let webRect = NSRect(x: x, y: webY, width: width, height: height)
            glass.frame = rec.webView.convert(webRect, to: contentView).integral
            glass.cornerRadius = max(0, min(number(raw, "cornerRadius") ?? min(width, height) / 2, min(width, height) / 2))
            glass.style = (raw["style"] as? String) == "clear" ? .clear : .regular
            let tintWhite = max(0, min(number(raw, "tintWhite") ?? 1, 1))
            let tintAlpha = max(0, min(number(raw, "tintAlpha") ?? 0, 1))
            glass.tintColor = tintAlpha > 0
                ? NSColor(srgbRed: tintWhite, green: tintWhite, blue: tintWhite, alpha: tintAlpha)
                : nil
            // Glaze's WindowContainerViewController sets this private AppKit
            // property to 1 for every native glass surface. AppKit's default is 2.
            let adaptiveAppearance = Int(max(0, min(number(raw, "adaptiveAppearance") ?? 1, 2)))
            let adaptiveSelector = NSSelectorFromString("set_adaptiveAppearance:")
            if glass.responds(to: adaptiveSelector) {
                glass.setValue(NSNumber(value: adaptiveAppearance), forKey: "_adaptiveAppearance")
            }
            if #available(macOS 27.0, *) {
                glass.effectIsInteractive = (raw["interactive"] as? Bool) ?? false
            }
            glass.isHidden = false
            retained.insert(id)
        }

        for (id, view) in rec.nativeGlassViews where !retained.contains(id) {
            view.removeFromSuperview()
            rec.nativeGlassViews.removeValue(forKey: id)
        }
        publishNativeGlassState(supported: true, ids: retained.sorted(), to: rec.webView)
    }

    private func publishNativeGlassState(supported: Bool, ids: [String], to webView: WKWebView) {
        let payload: [String: Any] = ["supported": supported, "count": ids.count, "ids": ids]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__GAPP_NATIVE_GLASS_APPLIED__ = \(json); window.dispatchEvent(new CustomEvent('gapp-native-glass-applied', {detail: window.__GAPP_NATIVE_GLASS_APPLIED__}));", completionHandler: nil)
    }

    // MARK: - Native Window Drag Regions

    private func installWindowDragMonitor() {
        guard windowDragMouseMonitor == nil else { return }
        windowDragMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] event in
            guard let self else { return event }
            guard let window = event.window else { return event }
            let windowIdentity = UInt(bitPattern: Unmanaged.passUnretained(window).toOpaque())
            let location = event.locationInWindow
            let shouldDrag = MainActor.assumeIsolated {
                self.shouldPerformWindowDrag(windowIdentity: windowIdentity, locationInWindow: location)
            }
            guard shouldDrag else { return event }
            window.performDrag(with: event)
            return nil
        }
    }

    private func updateWindowDragRegions(_ payload: [String: Any], for rec: WindowRecord) {
        func number(_ raw: [String: Any], _ key: String) -> CGFloat? {
            guard let value = raw[key] as? NSNumber else { return nil }
            let result = CGFloat(truncating: value)
            return result.isFinite ? result : nil
        }
        func regions(_ key: String, limit: Int) -> [NSRect] {
            guard let rawRegions = payload[key] as? [[String: Any]] else { return [] }
            let webHeight = rec.webView.bounds.height
            return rawRegions.prefix(limit).compactMap { raw in
                guard let x = number(raw, "x"), let y = number(raw, "y"),
                      let width = number(raw, "width"), let height = number(raw, "height"),
                      width > 0, height > 0, width <= 4096, height <= 4096 else { return nil }
                let webY = rec.webView.isFlipped ? y : webHeight - y - height
                return NSRect(x: x, y: webY, width: width, height: height).integral
            }
        }
        rec.windowDragRegions = regions("drag", limit: 8)
        rec.windowNoDragRegions = regions("noDrag", limit: 32)
        let payload: [String: Any] = [
            "dragCount": rec.windowDragRegions.count,
            "noDragCount": rec.windowNoDragRegions.count,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        rec.webView.evaluateJavaScript(
            "window.__GAPP_WINDOW_DRAG_APPLIED__ = \(json); window.dispatchEvent(new CustomEvent('gapp-window-drag-applied', {detail: window.__GAPP_WINDOW_DRAG_APPLIED__}));",
            completionHandler: nil
        )
    }

    // MARK: - Native Image Bridge

    private func resolveNativeImageRequest(
        id: String,
        result: Any? = nil,
        error: String? = nil,
        to webView: WKWebView
    ) {
        let arguments: [Any] = [id, result ?? NSNull(), error ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.__GLIMPSE_NATIVE_IMAGE_RESOLVE__?.apply(null, \(json))"
        ) { _, evaluationError in
            if let evaluationError {
                log("NativeImage resolve JavaScript failed id=\(id): \(evaluationError)")
            } else {
                log("NativeImage resolve JavaScript completed id=\(id) error=\(error != nil)")
            }
        }
    }

    private func serializedNativeImage(_ image: NSImage, isTemplate: Bool) -> [String: Any]? {
        guard image.size.width.isFinite, image.size.height.isFinite,
              image.size.width > 0, image.size.height > 0,
              image.size.width <= 4096, image.size.height <= 4096 else { return nil }

        let pixelWidth = max(1, Int(ceil(image.size.width)))
        let pixelHeight = max(1, Int(ceil(image.size.height)))
        let bitmap: NSBitmapImageRep?
        var proposedRect = NSRect(origin: .zero, size: image.size)
        if let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) {
            bitmap = NSBitmapImageRep(cgImage: cgImage)
        } else if let rendered = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixelWidth,
            pixelsHigh: pixelHeight,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bitmapFormat: [],
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) {
            rendered.size = image.size
            NSGraphicsContext.saveGraphicsState()
            if let context = NSGraphicsContext(bitmapImageRep: rendered) {
                NSGraphicsContext.current = context
                NSColor.clear.setFill()
                NSRect(origin: .zero, size: image.size).fill()
                image.draw(
                    in: NSRect(origin: .zero, size: image.size),
                    from: .zero,
                    operation: .sourceOver,
                    fraction: 1
                )
                context.flushGraphics()
            }
            NSGraphicsContext.restoreGraphicsState()
            bitmap = rendered
        } else {
            bitmap = nil
        }

        guard let bitmap,
              let png = bitmap.representation(using: .png, properties: [:]),
              png.count <= 16 * 1024 * 1024 else { return nil }
        let dataURL = "data:image/png;base64," + png.base64EncodedString()
        let size: [String: Any] = [
            "width": image.size.width,
            "height": image.size.height,
        ]
        let representation: [String: Any] = [
            "scaleFactor": 1,
            "dataURL": dataURL,
            "size": size,
        ]
        return [
            "isEmpty": false,
            "isTemplate": isTemplate,
            "dataURL": dataURL,
            "size": size,
            "representations": [representation],
        ]
    }

    private func handleNativeImageRequest(_ request: [String: Any], for rec: WindowRecord) {
        log("NativeImage request keys=\(request.keys.sorted())")
        guard let id = request["id"] as? String, !id.isEmpty, id.count <= 128,
              let channel = request["channel"] as? String,
              let argument = request["argument"] as? [String: Any] else {
            log("NativeImage request rejected before parsing")
            return
        }
        log("NativeImage request parsed id=\(id) channel=\(channel)")

        let image: NSImage?
        let isTemplate: Bool
        switch channel {
        case "nativeImage:createFromNamedImage":
            guard let imageName = argument["imageName"] as? String,
                  !imageName.isEmpty, imageName.count <= 128,
                  !imageName.contains("/"), !imageName.contains("\\"),
                  imageName.unicodeScalars.allSatisfy({
                      CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-")).contains($0)
                  }) else {
                resolveNativeImageRequest(id: id, error: "Invalid native image name", to: rec.webView)
                return
            }
            image = NSImage(systemSymbolName: imageName, accessibilityDescription: nil)
            isTemplate = true
        case "nativeImage:createFromPath":
            guard let path = argument["path"] as? String,
                  !path.isEmpty, path.count <= 4096,
                  NSString(string: path).isAbsolutePath else {
                resolveNativeImageRequest(id: id, error: "Invalid native image path", to: rec.webView)
                return
            }
            let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  values.isRegularFile == true,
                  let fileSize = values.fileSize, fileSize >= 0, fileSize <= 32 * 1024 * 1024 else {
                resolveNativeImageRequest(id: id, error: "Native image path is not a supported file", to: rec.webView)
                return
            }
            image = NSImage(contentsOf: url)
            isTemplate = false
        default:
            resolveNativeImageRequest(id: id, error: "Unsupported native image channel", to: rec.webView)
            return
        }

        guard let image else {
            log("NativeImage load failed id=\(id) channel=\(channel)")
            resolveNativeImageRequest(id: id, error: "Unable to decode native image", to: rec.webView)
            return
        }
        log("NativeImage loaded id=\(id) size=\(image.size)")
        guard let serialized = serializedNativeImage(image, isTemplate: isTemplate) else {
            log("NativeImage PNG serialization failed id=\(id)")
            resolveNativeImageRequest(id: id, error: "Unable to decode native image", to: rec.webView)
            return
        }
        log("NativeImage serialized id=\(id) dataURLChars=\((serialized["dataURL"] as? String)?.count ?? 0)")
        resolveNativeImageRequest(id: id, result: serialized, to: rec.webView)
    }

    // MARK: - Native Menu Bridge

    private func resolveNativeMenuRequest(
        id: String,
        result: Any? = nil,
        error: String? = nil,
        to webView: WKWebView
    ) {
        let arguments: [Any] = [id, result ?? NSNull(), error ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.__GLIMPSE_NATIVE_MENU_RESOLVE__?.apply(null, \(json))",
            completionHandler: nil
        )
    }

    private func nativeMenuAccelerator(_ value: String?) -> (key: String, modifiers: NSEvent.ModifierFlags) {
        guard let value, !value.isEmpty else { return ("", []) }
        let parts = value.split(separator: "+").map { String($0).lowercased() }
        guard let keyPart = parts.last else { return ("", []) }
        var modifiers: NSEvent.ModifierFlags = []
        for part in parts.dropLast() {
            switch part {
            case "command", "cmd", "commandorcontrol", "cmdorctrl": modifiers.insert(.command)
            case "control", "ctrl": modifiers.insert(.control)
            case "option", "alt": modifiers.insert(.option)
            case "shift": modifiers.insert(.shift)
            default: break
            }
        }
        let key: String
        switch keyPart {
        case "space": key = " "
        case "enter", "return": key = "\r"
        case "escape", "esc": key = "\u{1b}"
        case "backspace", "delete": key = "\u{8}"
        case "up": key = String(UnicodeScalar(NSUpArrowFunctionKey)!)
        case "down": key = String(UnicodeScalar(NSDownArrowFunctionKey)!)
        case "left": key = String(UnicodeScalar(NSLeftArrowFunctionKey)!)
        case "right": key = String(UnicodeScalar(NSRightArrowFunctionKey)!)
        default: key = keyPart.count == 1 ? keyPart : ""
        }
        return (key, modifiers)
    }

    private func nativeMenuImage(path: String?, template: Bool) -> NSImage? {
        guard let path, !path.isEmpty, path.count <= 4096 else { return nil }
        let isSymbol = !path.contains("/") && !path.contains("\\")
        let image = isSymbol
            ? NSImage(systemSymbolName: path, accessibilityDescription: nil)
            : NSImage(contentsOfFile: path)
        image?.isTemplate = template
        return image
    }

    private func buildNativeMenu(
        _ rawItems: [[String: Any]],
        selection: NativeMenuSelectionTarget,
        depth: Int = 0
    ) -> NSMenu? {
        guard depth <= 8, rawItems.count <= 256 else { return nil }
        let menu = NSMenu(title: "")
        menu.autoenablesItems = false
        for raw in rawItems {
            if raw["visible"] as? Bool == false { continue }
            let type = raw["type"] as? String ?? "normal"
            if type == "separator" {
                menu.addItem(.separator())
                continue
            }
            let label = String((raw["label"] as? String ?? "").prefix(512))
            let commandId = (raw["commandId"] as? NSNumber)?.intValue
            let action = commandId == nil ? nil : #selector(NativeMenuSelectionTarget.select(_:))
            let accelerator = nativeMenuAccelerator(raw["accelerator"] as? String)
            let item = NSMenuItem(title: label, action: action, keyEquivalent: accelerator.key)
            item.keyEquivalentModifierMask = accelerator.modifiers
            item.target = action == nil ? nil : selection
            if let commandId { item.representedObject = NSNumber(value: commandId) }
            item.isEnabled = (raw["enabled"] as? Bool) ?? (type != "header")
            item.state = (raw["checked"] as? Bool ?? false) ? .on : .off
            if let toolTip = raw["toolTip"] as? String { item.toolTip = String(toolTip.prefix(1024)) }
            if #available(macOS 14.0, *), let sublabel = raw["sublabel"] as? String {
                item.subtitle = String(sublabel.prefix(512))
            }
            item.image = nativeMenuImage(
                path: raw["icon"] as? String,
                template: raw["iconIsTemplate"] as? Bool ?? false
            )
            if let id = raw["id"] as? String, !id.isEmpty {
                item.identifier = NSUserInterfaceItemIdentifier(String(id.prefix(256)))
            }
            if type == "submenu" {
                guard let submenuItems = raw["submenu"] as? [[String: Any]],
                      let submenu = buildNativeMenu(submenuItems, selection: selection, depth: depth + 1) else {
                    return nil
                }
                item.submenu = submenu
                item.target = nil
                item.action = nil
            }
            menu.addItem(item)
        }
        return menu
    }

    private func handleNativeMenuRequest(_ request: [String: Any], for rec: WindowRecord) {
        guard let id = request["id"] as? String, !id.isEmpty, id.count <= 128,
              let method = request["method"] as? String else { return }
        guard method == "popup" else {
            resolveNativeMenuRequest(id: id, error: "Unknown native Menu method: \(method)", to: rec.webView)
            return
        }
        guard let options = request["options"] as? [String: Any],
              let items = options["items"] as? [[String: Any]], !items.isEmpty else {
            resolveNativeMenuRequest(id: id, error: "Menu.popup requires a non-empty items array", to: rec.webView)
            return
        }
        let coordinateSpace = options["coordinateSpace"] as? String ?? "screen"
        guard coordinateSpace == "view" || coordinateSpace == "screen" else {
            resolveNativeMenuRequest(id: id, error: "Unsupported menu coordinateSpace", to: rec.webView)
            return
        }
        let selection = NativeMenuSelectionTarget()
        guard let menu = buildNativeMenu(items, selection: selection) else {
            resolveNativeMenuRequest(id: id, error: "Invalid native menu template", to: rec.webView)
            return
        }
        if let width = options["minWidth"] as? NSNumber {
            menu.minimumWidth = max(0, min(CGFloat(truncating: width), 2048))
        }
        let x = CGFloat(truncating: options["x"] as? NSNumber ?? 0)
        let y = CGFloat(truncating: options["y"] as? NSNumber ?? 0)
        let point: NSPoint
        if coordinateSpace == "view" {
            point = NSPoint(x: x, y: rec.webView.isFlipped ? y : rec.webView.bounds.height - y)
        } else {
            let top = NSScreen.screens.map { $0.frame.maxY }.max() ?? 0
            let screenPoint = NSPoint(x: x, y: top - y)
            point = rec.webView.convert(rec.window.convertPoint(fromScreen: screenPoint), from: nil)
        }
        let positioningItem: NSMenuItem?
        if let rawIndex = options["positioningItem"] as? NSNumber {
            let index = rawIndex.intValue
            positioningItem = menu.items.indices.contains(index) ? menu.items[index] : nil
        } else {
            positioningItem = nil
        }
        _ = menu.popUp(positioning: positioningItem, at: point, in: rec.webView)
        let result: [String: Any] = selection.commandId.map { ["commandId": $0] } ?? [:]
        resolveNativeMenuRequest(id: id, result: result, to: rec.webView)
    }

    // MARK: - OpenGlaze Native Notification Bridge

    private func nativeNotificationString(_ value: Any?, maxLength: Int) -> String? {
        guard let value = value as? String, value.count <= maxLength else { return nil }
        return value
    }

    private func dispatchNativeNotificationEvent(
        id: String,
        event: String,
        payload: [String: Any] = [:],
        to webView: WKWebView
    ) {
        let arguments: [Any] = [id, event, payload]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.__GLIMPSE_NATIVE_NOTIFICATION_EVENT__?.apply(null, \(json))",
            completionHandler: nil
        )
    }

    private func recordForNativeNotification(id: String) -> WindowRecord? {
        guard let recordId = nativeNotificationOwners[id], let rec = records[recordId], !rec.closed else {
            nativeNotificationOwners.removeValue(forKey: id)
            return nil
        }
        return rec
    }

    private func failNativeNotification(id: String, message: String, for rec: WindowRecord) {
        nativeNotificationOwners.removeValue(forKey: id)
        nativeNotificationBackends.removeValue(forKey: id)
        nativeNotificationShown.remove(id)
        dispatchNativeNotificationEvent(
            id: id,
            event: "failed",
            payload: ["type": "failed", "error": message],
            to: rec.webView
        )
    }

    private func emitNativeNotificationShowOnce(id: String, backend: String, for rec: WindowRecord) {
        guard nativeNotificationOwners[id] == rec.id, !nativeNotificationShown.contains(id) else { return }
        nativeNotificationShown.insert(id)
        nativeNotificationBackends[id] = backend
        dispatchNativeNotificationEvent(
            id: id,
            event: "show",
            payload: ["type": "show", "delivered": true, "backend": backend],
            to: rec.webView
        )
    }

    private func confirmNativeNotificationDelivery(
        id: String,
        options: [String: Any],
        attempt: Int,
        for rec: WindowRecord
    ) {
        UNUserNotificationCenter.current().getDeliveredNotifications { [weak self, weak rec] notifications in
            DispatchQueue.main.async {
                guard let self, let rec, !rec.closed, self.nativeNotificationOwners[id] == rec.id else { return }
                let delivered = notifications.contains { $0.request.identifier == id }
                if delivered {
                    self.emitNativeNotificationShowOnce(id: id, backend: "userNotifications", for: rec)
                } else if attempt >= 30 {
                    self.showLegacyNativeNotification(id: id, options: options, for: rec)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        self.confirmNativeNotificationDelivery(id: id, options: options, attempt: attempt + 1, for: rec)
                    }
                }
            }
        }
    }

    private func scheduleNativeNotification(id: String, options: [String: Any], for rec: WindowRecord) {
        let content = UNMutableNotificationContent()
        content.title = nativeNotificationString(options["title"], maxLength: 512) ?? ""
        content.subtitle = nativeNotificationString(options["subtitle"], maxLength: 1024) ?? ""
        content.body = nativeNotificationString(options["body"], maxLength: 16_384) ?? ""
        content.categoryIdentifier = "GLIMPSE_NOTIFICATION"
        content.userInfo = ["glimpseNotificationId": id]
        let silent = options["silent"] as? Bool == true
        if !silent {
            if let sound = nativeNotificationString(options["sound"], maxLength: 256), !sound.isEmpty {
                content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: sound))
            } else {
                content.sound = .default
            }
        }
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { [weak self, weak rec] error in
            DispatchQueue.main.async {
                guard let self, let rec, !rec.closed else { return }
                if let error {
                    self.failNativeNotification(id: id, message: error.localizedDescription, for: rec)
                    return
                }
                self.confirmNativeNotificationDelivery(id: id, options: options, attempt: 0, for: rec)
            }
        }
    }

    private func legacyNativeNotificationCenter() -> NSObject? {
        guard let centerClass = NSClassFromString("NSUserNotificationCenter") as? NSObject.Type else { return nil }
        return centerClass.perform(NSSelectorFromString("defaultUserNotificationCenter"))?.takeUnretainedValue() as? NSObject
    }

    private func legacyNativeNotification(identifier: String, in center: NSObject) -> NSObject? {
        guard let notifications = center.value(forKey: "deliveredNotifications") as? [NSObject] else { return nil }
        return notifications.first { ($0.value(forKey: "identifier") as? String) == identifier }
    }

    private func confirmLegacyNativeNotificationDelivery(
        id: String,
        options: [String: Any],
        attempt: Int,
        for rec: WindowRecord
    ) {
        guard nativeNotificationOwners[id] == rec.id else { return }
        guard let center = legacyNativeNotificationCenter() else {
            failNativeNotification(id: id, message: "Legacy notification center is unavailable", for: rec)
            return
        }
        if legacyNativeNotification(identifier: id, in: center) != nil {
            emitNativeNotificationShowOnce(id: id, backend: "legacyNotificationCenter", for: rec)
        } else if attempt >= 30 {
            failNativeNotification(id: id, message: "Native notification was not delivered", for: rec)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.confirmLegacyNativeNotificationDelivery(id: id, options: options, attempt: attempt + 1, for: rec)
            }
        }
    }

    private func showLegacyNativeNotification(id: String, options: [String: Any], for rec: WindowRecord) {
        guard let center = legacyNativeNotificationCenter(),
              let notificationClass = NSClassFromString("NSUserNotification") as? NSObject.Type else {
            failNativeNotification(id: id, message: "Native notification compatibility backend is unavailable", for: rec)
            return
        }
        center.setValue(self, forKey: "delegate")
        if let existing = legacyNativeNotification(identifier: id, in: center) {
            _ = center.perform(NSSelectorFromString("removeDeliveredNotification:"), with: existing)
        }
        let notification = notificationClass.init()
        notification.setValue(id, forKey: "identifier")
        notification.setValue(nativeNotificationString(options["title"], maxLength: 512) ?? "", forKey: "title")
        notification.setValue(nativeNotificationString(options["subtitle"], maxLength: 1024) ?? "", forKey: "subtitle")
        notification.setValue(nativeNotificationString(options["body"], maxLength: 16_384) ?? "", forKey: "informativeText")
        notification.setValue(["glimpseNotificationId": id], forKey: "userInfo")
        if options["silent"] as? Bool != true {
            let sound = nativeNotificationString(options["sound"], maxLength: 256)
            notification.setValue(sound?.isEmpty == false ? sound : "NSUserNotificationDefaultSoundName", forKey: "soundName")
        }
        nativeNotificationBackends[id] = "legacyNotificationCenter"
        _ = center.perform(NSSelectorFromString("deliverNotification:"), with: notification)
        confirmLegacyNativeNotificationDelivery(id: id, options: options, attempt: 0, for: rec)
    }

    private func closeLegacyNativeNotification(id: String) {
        guard let center = legacyNativeNotificationCenter(),
              let notification = legacyNativeNotification(identifier: id, in: center) else { return }
        _ = center.perform(NSSelectorFromString("removeDeliveredNotification:"), with: notification)
    }

    @objc(userNotificationCenter:shouldPresentNotification:)
    func legacyNotificationCenterShouldPresent(_ center: AnyObject, notification: AnyObject) -> Bool {
        true
    }

    @objc(userNotificationCenter:didDeliverNotification:)
    func legacyNotificationCenterDidDeliver(_ center: AnyObject, notification: AnyObject) {
        guard let object = notification as? NSObject,
              let id = object.value(forKey: "identifier") as? String,
              let rec = recordForNativeNotification(id: id) else { return }
        emitNativeNotificationShowOnce(id: id, backend: "legacyNotificationCenter", for: rec)
    }

    @objc(userNotificationCenter:didActivateNotification:)
    func legacyNotificationCenterDidActivate(_ center: AnyObject, notification: AnyObject) {
        guard let object = notification as? NSObject,
              let id = object.value(forKey: "identifier") as? String,
              let rec = recordForNativeNotification(id: id) else { return }
        nativeNotificationOwners.removeValue(forKey: id)
        nativeNotificationBackends.removeValue(forKey: id)
        nativeNotificationShown.remove(id)
        dispatchNativeNotificationEvent(
            id: id,
            event: "click",
            payload: ["type": "click", "backend": "legacyNotificationCenter"],
            to: rec.webView
        )
    }

    private func authorizeAndShowNativeNotification(id: String, options: [String: Any], for rec: WindowRecord) {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self, weak rec] settings in
            DispatchQueue.main.async {
                guard let self, let rec, !rec.closed else { return }
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    self.nativeNotificationBackends[id] = "userNotifications"
                    self.scheduleNativeNotification(id: id, options: options, for: rec)
                case .notDetermined:
                    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self, weak rec] granted, _ in
                        DispatchQueue.main.async {
                            guard let self, let rec, !rec.closed else { return }
                            if granted {
                                self.nativeNotificationBackends[id] = "userNotifications"
                                self.scheduleNativeNotification(id: id, options: options, for: rec)
                            } else {
                                self.showLegacyNativeNotification(id: id, options: options, for: rec)
                            }
                        }
                    }
                default:
                    self.showLegacyNativeNotification(id: id, options: options, for: rec)
                }
            }
        }
    }

    private func handleNativeNotificationRequest(_ request: [String: Any], for rec: WindowRecord) {
        guard let method = request["method"] as? String,
              let id = request["id"] as? String,
              !id.isEmpty, id.count <= 256,
              id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return }
        switch method {
        case "show":
            guard let options = request["options"] as? [String: Any] else {
                failNativeNotification(id: id, message: "Invalid notification options", for: rec)
                return
            }
            if let existingOwner = nativeNotificationOwners[id], existingOwner != rec.id {
                failNativeNotification(id: id, message: "Notification id is already owned by another window", for: rec)
                return
            }
            nativeNotificationOwners[id] = rec.id
            nativeNotificationShown.remove(id)
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
            authorizeAndShowNativeNotification(id: id, options: options, for: rec)
        case "close":
            guard nativeNotificationOwners[id] == rec.id else { return }
            let backend = nativeNotificationBackends[id] ?? "unknown"
            let center = UNUserNotificationCenter.current()
            center.removePendingNotificationRequests(withIdentifiers: [id])
            center.removeDeliveredNotifications(withIdentifiers: [id])
            closeLegacyNativeNotification(id: id)
            nativeNotificationOwners.removeValue(forKey: id)
            nativeNotificationBackends.removeValue(forKey: id)
            nativeNotificationShown.remove(id)
            dispatchNativeNotificationEvent(
                id: id,
                event: "close",
                payload: ["type": "close", "backend": backend],
                to: rec.webView
            )
        default:
            failNativeNotification(id: id, message: "Unsupported native notification method", for: rec)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let id = response.notification.request.identifier
        MainActor.assumeIsolated {
            guard let rec = self.recordForNativeNotification(id: id) else {
                completionHandler()
                return
            }
            let event = response.actionIdentifier == UNNotificationDismissActionIdentifier ? "close" : "click"
            self.nativeNotificationOwners.removeValue(forKey: id)
            self.nativeNotificationBackends.removeValue(forKey: id)
            self.nativeNotificationShown.remove(id)
            self.dispatchNativeNotificationEvent(
                id: id,
                event: event,
                payload: ["type": event],
                to: rec.webView
            )
            completionHandler()
        }
    }

    // MARK: - Native Dialog Bridge

    private func resolveNativeDialogRequest(
        id: String,
        result: Any? = nil,
        error: String? = nil,
        for rec: WindowRecord
    ) {
        rec.nativeDialogRequestIds.remove(id)
        let arguments: [Any] = [id, result ?? NSNull(), error ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        rec.webView.evaluateJavaScript(
            "window.__GLIMPSE_NATIVE_DIALOG_RESOLVE__?.apply(null, \(json))",
            completionHandler: nil
        )
    }

    private func nativeDialogString(_ value: Any?, maxLength: Int = 4096) -> String? {
        guard let value = value as? String, value.count <= maxLength else { return nil }
        return value
    }

    private func nativeDialogOptions(_ args: [Any]) -> [String: Any]? {
        guard let first = args.first else { return [:] }
        if first is NSNull { return [:] }
        return first as? [String: Any]
    }

    private func configureNativeFilePanel(_ panel: NSSavePanel, options: [String: Any]) {
        if let title = nativeDialogString(options["title"], maxLength: 512) { panel.title = title }
        if let message = nativeDialogString(options["message"], maxLength: 4096) { panel.message = message }
        if let label = nativeDialogString(options["buttonLabel"], maxLength: 256) { panel.prompt = label }
        if let label = nativeDialogString(options["nameFieldLabel"], maxLength: 256) { panel.nameFieldLabel = label }
        if let showsTagField = options["showsTagField"] as? Bool { panel.showsTagField = showsTagField }

        if let defaultPath = nativeDialogString(options["defaultPath"], maxLength: 16_384), !defaultPath.isEmpty {
            let url = URL(fileURLWithPath: defaultPath).standardizedFileURL
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
                panel.directoryURL = url
            } else {
                panel.directoryURL = url.deletingLastPathComponent()
                if !url.lastPathComponent.isEmpty { panel.nameFieldStringValue = url.lastPathComponent }
            }
        }

        if let filters = options["filters"] as? [[String: Any]] {
            var extensions: [String] = []
            var allowsAll = false
            for filter in filters.prefix(64) {
                guard let values = filter["extensions"] as? [String] else { continue }
                for value in values.prefix(128) {
                    let ext = value.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
                    if ext == "*" { allowsAll = true }
                    else if !ext.isEmpty, ext.count <= 64 { extensions.append(ext) }
                }
            }
            let contentTypes = Array(Set(extensions)).sorted().compactMap { UTType(filenameExtension: $0) }
            if !contentTypes.isEmpty { panel.allowedContentTypes = contentTypes }
            panel.allowsOtherFileTypes = allowsAll
        }
    }

    private func securityScopedBookmark(for url: URL) -> String? {
        guard let data = try? url.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else { return nil }
        return data.base64EncodedString()
    }

    private func handleNativeOpenDialog(id: String, options: [String: Any], for rec: WindowRecord) {
        let panel = NSOpenPanel()
        configureNativeFilePanel(panel, options: options)
        let properties = Set(options["properties"] as? [String] ?? ["openFile"])
        panel.canChooseFiles = properties.contains("openFile") || !properties.contains("openDirectory")
        panel.canChooseDirectories = properties.contains("openDirectory")
        panel.allowsMultipleSelection = properties.contains("multiSelections")
        panel.showsHiddenFiles = properties.contains("showHiddenFiles")
        panel.canCreateDirectories = properties.contains("createDirectory")
        panel.resolvesAliases = !properties.contains("noResolveAliases")
        panel.treatsFilePackagesAsDirectories = properties.contains("treatPackageAsDirectory")
        let wantsBookmarks = options["securityScopedBookmarks"] as? Bool == true
        panel.beginSheetModal(for: rec.window) { [weak self, weak rec] response in
            guard let self, let rec, !rec.closed else { return }
            let accepted = response == .OK
            var result: [String: Any] = [
                "canceled": !accepted,
                "filePaths": accepted ? panel.urls.map { $0.path } : [],
            ]
            if wantsBookmarks, accepted {
                result["bookmarks"] = panel.urls.map { self.securityScopedBookmark(for: $0) ?? "" }
            }
            self.resolveNativeDialogRequest(id: id, result: result, for: rec)
        }
    }

    private func handleNativeSaveDialog(id: String, options: [String: Any], for rec: WindowRecord) {
        let panel = NSSavePanel()
        configureNativeFilePanel(panel, options: options)
        let properties = Set(options["properties"] as? [String] ?? [])
        panel.showsHiddenFiles = properties.contains("showHiddenFiles")
        panel.canCreateDirectories = properties.contains("createDirectory")
        panel.treatsFilePackagesAsDirectories = properties.contains("treatPackageAsDirectory")
        let wantsBookmarks = options["securityScopedBookmarks"] as? Bool == true
        panel.beginSheetModal(for: rec.window) { [weak self, weak rec] response in
            guard let self, let rec, !rec.closed else { return }
            let accepted = response == .OK
            var result: [String: Any] = [
                "canceled": !accepted,
                "filePath": accepted ? (panel.url?.path ?? "") : "",
            ]
            if wantsBookmarks, accepted, let url = panel.url, let bookmark = self.securityScopedBookmark(for: url) {
                result["bookmark"] = bookmark
            }
            self.resolveNativeDialogRequest(id: id, result: result, for: rec)
        }
    }

    private func handleNativeMessageBox(id: String, options: [String: Any], for rec: WindowRecord) {
        guard let message = nativeDialogString(options["message"], maxLength: 16_384), !message.isEmpty else {
            resolveNativeDialogRequest(id: id, error: "MessageBox requires a non-empty message", for: rec)
            return
        }
        let alert = NSAlert()
        switch options["type"] as? String {
        case "error": alert.alertStyle = .critical
        case "warning": alert.alertStyle = .warning
        default: alert.alertStyle = .informational
        }
        alert.messageText = message
        if let detail = nativeDialogString(options["detail"], maxLength: 32_768) { alert.informativeText = detail }
        let rawButtons = options["buttons"] as? [String] ?? ["OK"]
        let buttonTitles = rawButtons.prefix(32).map { String($0.prefix(256)) }.filter { !$0.isEmpty }
        for title in buttonTitles.isEmpty ? ["OK"] : buttonTitles { alert.addButton(withTitle: title) }
        if let defaultId = (options["defaultId"] as? NSNumber)?.intValue,
           alert.buttons.indices.contains(defaultId) {
            for button in alert.buttons where button.keyEquivalent == "\r" { button.keyEquivalent = "" }
            alert.buttons[defaultId].keyEquivalent = "\r"
        }
        if let cancelId = (options["cancelId"] as? NSNumber)?.intValue,
           alert.buttons.indices.contains(cancelId) {
            alert.buttons[cancelId].keyEquivalent = "\u{1b}"
        }
        if let label = nativeDialogString(options["checkboxLabel"], maxLength: 512), !label.isEmpty {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = label
            alert.suppressionButton?.state = options["checkboxChecked"] as? Bool == true ? .on : .off
        }
        if let title = nativeDialogString(options["title"], maxLength: 512), !title.isEmpty {
            alert.window.title = title
        }
        if let iconPath = nativeDialogString(options["icon"], maxLength: 16_384),
           FileManager.default.fileExists(atPath: iconPath), let image = NSImage(contentsOfFile: iconPath) {
            alert.icon = image
        }
        alert.beginSheetModal(for: rec.window) { [weak self, weak rec] response in
            guard let self, let rec, !rec.closed else { return }
            let first = NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            let responseIndex = max(0, response.rawValue - first)
            self.resolveNativeDialogRequest(
                id: id,
                result: [
                    "response": responseIndex,
                    "checkboxChecked": alert.suppressionButton?.state == .on,
                ],
                for: rec
            )
        }
    }

    private func handleNativeErrorBox(id: String, args: [Any], for rec: WindowRecord) {
        guard args.count == 2,
              let title = nativeDialogString(args[0], maxLength: 512),
              let content = nativeDialogString(args[1], maxLength: 32_768) else {
            resolveNativeDialogRequest(id: id, error: "showErrorBox requires title and content strings", for: rec)
            return
        }
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = content
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: rec.window) { [weak self, weak rec] _ in
            guard let self, let rec, !rec.closed else { return }
            self.resolveNativeDialogRequest(id: id, result: NSNull(), for: rec)
        }
    }

    private func handleNativeDialogRequest(_ request: [String: Any], for rec: WindowRecord) {
        guard let id = request["id"] as? String, !id.isEmpty, id.count <= 128,
              let method = request["method"] as? String,
              let args = request["args"] as? [Any] else {
            if let id = request["id"] as? String {
                resolveNativeDialogRequest(id: id, error: "Invalid native dialog request", for: rec)
            }
            return
        }
        guard rec.nativeDialogRequestIds.isEmpty else {
            resolveNativeDialogRequest(id: id, error: "A native dialog is already open for this window", for: rec)
            return
        }
        rec.nativeDialogRequestIds.insert(id)
        switch method {
        case "showOpenDialog":
            guard let options = nativeDialogOptions(args) else {
                resolveNativeDialogRequest(id: id, error: "Invalid open dialog options", for: rec)
                return
            }
            handleNativeOpenDialog(id: id, options: options, for: rec)
        case "showSaveDialog":
            guard let options = nativeDialogOptions(args) else {
                resolveNativeDialogRequest(id: id, error: "Invalid save dialog options", for: rec)
                return
            }
            handleNativeSaveDialog(id: id, options: options, for: rec)
        case "showMessageBox":
            guard let options = nativeDialogOptions(args) else {
                resolveNativeDialogRequest(id: id, error: "Invalid message box options", for: rec)
                return
            }
            handleNativeMessageBox(id: id, options: options, for: rec)
        case "showErrorBox":
            handleNativeErrorBox(id: id, args: args, for: rec)
        default:
            resolveNativeDialogRequest(id: id, error: "Unsupported native dialog method", for: rec)
        }
    }

    // MARK: - Native Date Picker Bridge

    private func resolveNativeDatePickerRequest(
        id: String,
        result: Any? = nil,
        error: String? = nil,
        to webView: WKWebView
    ) {
        let arguments: [Any] = [id, result ?? NSNull(), error ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.__GLIMPSE_NATIVE_DATE_PICKER_RESOLVE__?.apply(null, \(json))",
            completionHandler: nil
        )
    }

    private func nativeDateFormatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = format
        formatter.isLenient = false
        return formatter
    }

    private func parseNativeDatePickerValue(_ value: String, mode: String) -> Date? {
        let formats: [String]
        switch mode {
        case "date": formats = ["yyyy-MM-dd"]
        case "time": formats = ["HH:mm", "HH:mm:ss"]
        case "dateAndTime": formats = ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm"]
        default: return nil
        }
        for format in formats {
            if let date = nativeDateFormatter(format).date(from: value) { return date }
        }
        if mode == "dateAndTime" {
            return ISO8601DateFormatter().date(from: value)
        }
        return nil
    }

    private func formatNativeDatePickerValue(_ date: Date, mode: String) -> String? {
        switch mode {
        case "date": return nativeDateFormatter("yyyy-MM-dd").string(from: date)
        case "time": return nativeDateFormatter("HH:mm").string(from: date)
        case "dateAndTime": return nativeDateFormatter("yyyy-MM-dd'T'HH:mm").string(from: date)
        default: return nil
        }
    }

    fileprivate func completeNativeDatePicker(
        requestId: String,
        recordId: String,
        date: Date?,
        canceled: Bool
    ) {
        guard let rec = records[recordId],
              let session = rec.nativeDatePickerSessions.removeValue(forKey: requestId),
              !session.completed else { return }
        session.completed = true
        session.popover.delegate = nil
        if session.popover.isShown { session.popover.performClose(nil) }
        session.host = nil

        var result: [String: Any] = ["canceled": canceled]
        if !canceled, let date, let value = formatNativeDatePickerValue(date, mode: session.mode) {
            result["value"] = value
        }
        resolveNativeDatePickerRequest(id: requestId, result: result, to: rec.webView)
    }

    private func handleNativeDatePickerRequest(_ request: [String: Any], for rec: WindowRecord) {
        guard let id = request["id"] as? String, !id.isEmpty, id.count <= 128,
              rec.nativeDatePickerSessions[id] == nil,
              let options = request["options"] as? [String: Any],
              let mode = options["mode"] as? String,
              ["date", "time", "dateAndTime"].contains(mode) else {
            if let id = request["id"] as? String {
                resolveNativeDatePickerRequest(id: id, error: "Invalid native date picker request", to: rec.webView)
            }
            return
        }

        func number(_ key: String) -> CGFloat? {
            guard let value = options[key] as? NSNumber else { return nil }
            let result = CGFloat(truncating: value)
            return result.isFinite ? result : nil
        }

        guard let x = number("x"), let y = number("y"),
              let width = number("width"), let height = number("height"),
              width > 0, height > 0, width <= 4096, height <= 4096 else {
            resolveNativeDatePickerRequest(id: id, error: "Invalid native date picker anchor rect", to: rec.webView)
            return
        }

        let initialDate: Date
        if let value = options["initialValue"] as? String {
            guard let parsed = parseNativeDatePickerValue(value, mode: mode) else {
                resolveNativeDatePickerRequest(id: id, error: "Invalid native date picker initialValue", to: rec.webView)
                return
            }
            initialDate = parsed
        } else {
            initialDate = Date()
        }

        let minDate: Date?
        if let value = options["min"] as? String {
            guard let parsed = parseNativeDatePickerValue(value, mode: mode) else {
                resolveNativeDatePickerRequest(id: id, error: "Invalid native date picker min", to: rec.webView)
                return
            }
            minDate = parsed
        } else {
            minDate = nil
        }

        let maxDate: Date?
        if let value = options["max"] as? String {
            guard let parsed = parseNativeDatePickerValue(value, mode: mode) else {
                resolveNativeDatePickerRequest(id: id, error: "Invalid native date picker max", to: rec.webView)
                return
            }
            maxDate = parsed
        } else {
            maxDate = nil
        }
        if let minDate, let maxDate, minDate > maxDate {
            resolveNativeDatePickerRequest(id: id, error: "Native date picker min exceeds max", to: rec.webView)
            return
        }

        let session = NativeDatePickerSession(requestId: id, recordId: rec.id, mode: mode, host: self)
        let picker = session.picker
        picker.datePickerMode = .single
        picker.focusRingType = .none
        picker.dateValue = initialDate
        picker.minDate = minDate
        picker.maxDate = maxDate

        if mode == "time" {
            picker.datePickerStyle = .textFieldAndStepper
            picker.datePickerElements = [.hourMinute]
        } else {
            picker.datePickerStyle = .clockAndCalendar
            picker.datePickerElements = mode == "dateAndTime" ? [.yearMonthDay, .hourMinute] : [.yearMonthDay]
        }
        picker.sizeToFit()
        let fitting = picker.fittingSize
        let pickerSize = NSSize(
            width: ceil(max(fitting.width, picker.frame.width)),
            height: ceil(max(fitting.height, picker.frame.height))
        )
        let horizontalPadding: CGFloat = 12
        let footerTop: CGFloat = 52
        let topPadding: CGFloat = 12
        let minimumButtonRowWidth: CGFloat = 188
        let contentSize = NSSize(
            width: max(minimumButtonRowWidth, pickerSize.width + horizontalPadding * 2),
            height: pickerSize.height + footerTop + topPadding
        )
        picker.frame = NSRect(
            x: floor((contentSize.width - pickerSize.width) / 2),
            y: footerTop,
            width: pickerSize.width,
            height: pickerSize.height
        )

        let cancel = NSButton(title: "Cancel", target: session, action: #selector(NativeDatePickerSession.cancel(_:)))
        cancel.keyEquivalent = "\u{1b}"
        cancel.frame = NSRect(x: contentSize.width - 176, y: 12, width: 76, height: 28)
        let done = NSButton(title: "Done", target: session, action: #selector(NativeDatePickerSession.accept(_:)))
        done.keyEquivalent = "\r"
        done.frame = NSRect(x: contentSize.width - 92, y: 12, width: 76, height: 28)

        let controller = NSViewController()
        controller.view = NSView(frame: NSRect(origin: .zero, size: contentSize))
        controller.preferredContentSize = contentSize
        controller.view.addSubview(picker)
        controller.view.addSubview(cancel)
        controller.view.addSubview(done)

        session.popover.contentViewController = controller
        session.popover.contentSize = contentSize
        session.popover.behavior = .transient
        rec.nativeDatePickerSessions[id] = session

        let webY = rec.webView.isFlipped ? y : rec.webView.bounds.height - y - height
        let anchor = NSRect(x: x, y: webY, width: width, height: height).integral
        session.popover.show(relativeTo: anchor, of: rec.webView, preferredEdge: .maxY)
    }

    // MARK: - Native Theme Bridge

    private func installNativeThemeObservers() {
        effectiveAppearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.publishNativeThemeStateToAll()
                }
            }
        }
        systemColorsObserver = NotificationCenter.default.addObserver(
            forName: NSColor.systemColorsDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.publishNativeThemeStateToAll()
            }
        }
    }

    private func nativeThemeInfo(for rec: WindowRecord) -> [String: Any] {
        let isDark = rec.window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        var info: [String: Any] = [
            "shouldUseDarkColors": isDark,
            "themeSource": rec.nativeThemeSource,
            "shouldUseHighContrastColors": NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast,
            "shouldUseDarkColorsForSystemIntegratedUI": isDark,
            "shouldUseInvertedColorScheme": NSWorkspace.shared.accessibilityDisplayShouldInvertColors,
            "prefersReducedTransparency": NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        ]
        if let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB) {
            info["accentColor"] = String(
                format: "#%02x%02x%02x",
                Int(accent.redComponent * 255),
                Int(accent.greenComponent * 255),
                Int(accent.blueComponent * 255)
            )
        }
        return info
    }

    @discardableResult
    private func setNativeThemeSource(_ source: String, for rec: WindowRecord) -> Bool {
        let appearance: NSAppearance?
        switch source {
        case "system": appearance = nil
        case "light": appearance = NSAppearance(named: .aqua)
        case "dark": appearance = NSAppearance(named: .darkAqua)
        default: return false
        }
        rec.nativeThemeSource = source
        rec.window.appearance = appearance
        rec.webView.appearance = appearance
        for view in rec.nativeGlassViews.values {
            view.appearance = appearance
        }
        rec.window.contentView?.needsDisplay = true
        rec.webView.needsDisplay = true
        publishNativeThemeState(to: rec)
        return true
    }

    private func publishNativeThemeStateToAll() {
        for rec in records.values where !rec.closed {
            publishNativeThemeState(to: rec)
        }
    }

    private func publishNativeThemeState(to rec: WindowRecord) {
        let arguments: [Any] = ["nativeTheme:updated", nativeThemeInfo(for: rec)]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        rec.webView.evaluateJavaScript(
            "window.__GLIMPSE_NATIVE_THEME_NOTIFY__?.apply(null, \(json))",
            completionHandler: nil
        )
    }

    private func resolveNativeThemeRequest(
        id: String,
        result: Any? = nil,
        error: String? = nil,
        to webView: WKWebView
    ) {
        let arguments: [Any] = [id, result ?? NSNull(), error ?? NSNull()]
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.__GLIMPSE_NATIVE_THEME_RESOLVE__?.apply(null, \(json))",
            completionHandler: nil
        )
    }

    private func handleNativeThemeRequest(_ request: [String: Any], for rec: WindowRecord) {
        guard let id = request["id"] as? String, !id.isEmpty, id.count <= 128,
              let method = request["method"] as? String else { return }
        switch method {
        case "getInfo":
            resolveNativeThemeRequest(id: id, result: nativeThemeInfo(for: rec), to: rec.webView)
        case "setThemeSource":
            guard let source = request["argument"] as? String,
                  setNativeThemeSource(source, for: rec) else {
                resolveNativeThemeRequest(
                    id: id,
                    error: "Error processing argument at index 0, conversion failure",
                    to: rec.webView
                )
                return
            }
            resolveNativeThemeRequest(id: id, result: true, to: rec.webView)
        case "getShouldUseDarkColors":
            resolveNativeThemeRequest(
                id: id,
                result: nativeThemeInfo(for: rec)["shouldUseDarkColors"] ?? false,
                to: rec.webView
            )
        case "getThemeSource":
            resolveNativeThemeRequest(id: id, result: rec.nativeThemeSource, to: rec.webView)
        default:
            resolveNativeThemeRequest(id: id, error: "Unknown nativeTheme method: \(method)", to: rec.webView)
        }
    }


    // MARK: - WKUIDelegate native child windows

    func webView(
        _ parentWebView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = navigationAction.request.url,
              url.absoluteString.hasPrefix("about:blank"),
              let parent = record(forWebView: parentWebView),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        guard let feature = query["feature"], ["tooltip", "hud"].contains(feature) else { return nil }

        func number(_ key: String) -> CGFloat? {
            guard let raw = query[key], let value = Double(raw), value.isFinite else { return nil }
            return CGFloat(value)
        }
        let reference: NSRect?
        if let x = number("referenceX"), let y = number("referenceY"),
           let width = number("referenceWidth"), let height = number("referenceHeight"),
           width > 0, height > 0 {
            reference = NSRect(x: x, y: y, width: width, height: height)
        } else {
            reference = nil
        }
        if feature == "tooltip" && reference == nil { return nil }

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .popUpMenu
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = feature == "tooltip"
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.isReleasedWhenClosed = false
        panel.appearance = parent.window.appearance

        guard let contentView = panel.contentView else { return nil }
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: contentView.bounds)
            glass.autoresizingMask = [.width, .height]
            glass.style = .regular
            glass.cornerRadius = 10
            glass.setValue(NSNumber(value: 1), forKey: "_adaptiveAppearance")
            contentView.addSubview(glass)
        } else {
            let material = NSVisualEffectView(frame: contentView.bounds)
            material.autoresizingMask = [.width, .height]
            material.blendingMode = .withinWindow
            material.material = .popover
            material.state = .active
            contentView.addSubview(material)
        }

        let childWebView = GlimpseWebView(frame: contentView.bounds, configuration: configuration)
        childWebView.host = self
        childWebView.autoresizingMask = [.width, .height]
        childWebView.navigationDelegate = self
        childWebView.uiDelegate = self
        childWebView.underPageBackgroundColor = .clear
        childWebView.setValue(false, forKey: "drawsBackground")
        childWebView.appearance = parent.webView.appearance
        enableWebViewInspection(childWebView)
        contentView.addSubview(childWebView)

        let id = "native-child-\(UUID().uuidString)"
        let child = NativeChildWindowRecord(
            id: id,
            parentId: parent.id,
            feature: feature,
            side: query["side"] ?? "top",
            reference: reference,
            window: panel,
            webView: childWebView
        )
        nativeChildRecords[ObjectIdentifier(childWebView)] = child
        parent.window.addChildWindow(panel, ordered: .above)
        panel.orderFrontRegardless()
        return childWebView
    }

    func webViewDidClose(_ webView: WKWebView) {
        guard let child = nativeChild(forWebView: webView) else { return }
        closeNativeChild(child)
    }

    // MARK: - WKScriptMessageHandler

    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = message.body as? String,
                  let data = body.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                log("Received invalid message from webview")
                return
            }

            let messageWebView = message.webView
            let child = messageWebView.flatMap { self.nativeChild(forWebView: $0) }
            let rec = messageWebView.flatMap { self.record(forWebView: $0) }
            if let rec { self.bindActive(from: rec) }

            if let resize = json["__glimpse_native_child_resize"] as? [String: Any], let child {
                resizeNativeChild(resize, child: child)
                return
            }

            if let animation = json["__glimpse_native_child_animation"] as? [String: Any],
               let action = animation["action"] as? String,
               let child {
                switch action {
                case "animateOut": animateOutNativeChild(child)
                case "cancelAnimateOut": cancelAnimateOutNativeChild(child)
                default: break
                }
                return
            }

            if json["__glimpse_close"] as? Bool == true {
                if let child {
                    closeNativeChild(child)
                } else if let rec {
                    closeRecord(rec, userInitiated: true)
                } else {
                    closeAndExit()
                }
                return
            }

            if let regions = json["__glimpse_native_glass"] as? [[String: Any]], let rec {
                updateNativeGlass(regions, for: rec)
                return
            }

            if let regions = json["__glimpse_window_drag_regions"] as? [String: Any], let rec {
                updateWindowDragRegions(regions, for: rec)
                return
            }

            if let request = json["__glimpse_native_theme"] as? [String: Any], let rec {
                handleNativeThemeRequest(request, for: rec)
                return
            }

            if let request = json["__glimpse_native_image"] as? [String: Any] {
                log("NativeImage script message received rec=\(rec != nil)")
                if let rec { handleNativeImageRequest(request, for: rec) }
                return
            }

            if let request = json["__glimpse_native_menu"] as? [String: Any], let rec {
                handleNativeMenuRequest(request, for: rec)
                return
            }

            if let request = json["__glimpse_native_notification"] as? [String: Any], let rec {
                handleNativeNotificationRequest(request, for: rec)
                return
            }

            if let request = json["__glimpse_native_dialog"] as? [String: Any], let rec {
                handleNativeDialogRequest(request, for: rec)
                return
            }

            if let request = json["__glimpse_native_date_picker"] as? [String: Any], let rec {
                handleNativeDatePickerRequest(request, for: rec)
                return
            }

            writeEvent(["type": "message", "data": json], id: rec?.id)
            let autoClose = rec?.config.autoClose ?? config.autoClose
            if autoClose {
                if let rec {
                    closeRecord(rec, userInitiated: true)
                } else {
                    closeAndExit()
                }
            }
        }
    }

    // MARK: - NSWindowDelegate

    private func setTransparentToolbarVisible(_ visible: Bool, for notification: Notification, phase: String) {
        guard let win = notification.object as? NSWindow,
              let rec = records.values.first(where: { $0.window === win }),
              rec.config.transparent, !rec.config.frameless,
              let toolbar = win.toolbar else { return }
        toolbar.isVisible = visible
        let chromeHeight = max(0, win.frame.height - win.contentLayoutRect.height)
        let fullScreen = win.styleMask.contains(.fullScreen)
        log(
            "WindowChrome phase=\(phase) id=\(rec.id) fullScreen=\(fullScreen) " +
            "toolbarVisible=\(toolbar.isVisible) chromeHeight=\(chromeHeight)"
        )
    }

    func windowWillEnterFullScreen(_ notification: Notification) {
        // The empty unified toolbar is only needed to place traffic lights in a
        // normal transparent window. In full screen it becomes a redundant tall
        // strip above the page's own toolbar, so remove it before the transition.
        setTransparentToolbarVisible(false, for: notification, phase: "willEnterFullScreen")
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        // AppKit may restore toolbar visibility while completing the transition.
        setTransparentToolbarVisible(false, for: notification, phase: "didEnterFullScreen")
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        setTransparentToolbarVisible(true, for: notification, phase: "didExitFullScreen")
    }

    func windowDidResize(_ notification: Notification) {
        guard let win = notification.object as? NSWindow,
              let rec = records.values.first(where: { $0.window === win }) else {
            if window != nil, let tip = computeCursorTip() {
                webView.evaluateJavaScript("window.glimpse.cursorTip = {x: \(tip["x"]!), y: \(tip["y"]!)}", completionHandler: nil)
            }
            return
        }
        bindActive(from: rec)
        rec.nativeFindController?.reposition()
        if let tip = computeCursorTip() {
            rec.webView.evaluateJavaScript("window.glimpse.cursorTip = {x: \(tip["x"]!), y: \(tip["y"]!)}", completionHandler: nil)
        }
    }

    func windowDidMove(_ notification: Notification) {
        guard let win = notification.object as? NSWindow,
              let rec = records.values.first(where: { $0.window === win }) else { return }
        rec.nativeFindController?.reposition()
    }

    func windowWillClose(_ notification: Notification) {
        guard let win = notification.object as? NSWindow else { return }
        if let rec = records.values.first(where: { $0.window === win }), !rec.closed {
            closeRecord(rec, userInitiated: false)
        }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        guard let win = notification.object as? NSWindow,
              let rec = records.values.first(where: { $0.window === win }), !rec.closed else { return }
        bindActive(from: rec)
        dispatchWindowFocus(true, to: rec.webView)
    }

    func windowDidResignKey(_ notification: Notification) {
        guard let win = notification.object as? NSWindow,
              let rec = records.values.first(where: { $0.window === win }), !rec.closed else { return }
        dispatchWindowFocus(false, to: rec.webView)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Always allow; closeRecord handles multi-window lifetime.
        true
    }
}

// MARK: - Entry Point

// Must be set before any WKWebView is created so WebKit installs developer
// extras (Inspect Element) into the default context menu on older macOS.
UserDefaults.standard.set(true, forKey: "WebKitDeveloperExtras")

let config = parseArgs()
let app = NSApplication.shared
let delegate = AppDelegate(config: config)
app.delegate = delegate
// Host mode and normal windows show in Dock (Chrome-like). Accessory only for
// menu-bar / click-through / pure hidden prewarm single-process launches.
let accessory = config.statusItem || config.clickThrough || (config.hidden && !config.hostMode)
app.setActivationPolicy(accessory ? .accessory : .regular)
if let icon = loadAppIconImage() {
    app.applicationIconImage = icon
}
app.run()
