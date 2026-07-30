import AppKit
import ApplicationServices
import Foundation

func value<T>(_ element: AXUIElement, _ attribute: String, as type: T.Type = T.self) -> T? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
    return raw as? T
}

func string(_ element: AXUIElement, _ attribute: String) -> String {
    value(element, attribute, as: String.self) ?? ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    value(element, kAXChildrenAttribute, as: [AXUIElement].self) ?? []
}

func descendants(_ root: AXUIElement, limit: Int = 1200) -> [AXUIElement] {
    var output: [AXUIElement] = []
    var queue = children(root)
    var index = 0
    while index < queue.count && output.count < limit {
        let item = queue[index]
        index += 1
        output.append(item)
        queue.append(contentsOf: children(item))
    }
    return output
}

func description(_ element: AXUIElement) -> [String: String] {
    [
        "role": string(element, kAXRoleAttribute),
        "subrole": string(element, kAXSubroleAttribute),
        "title": string(element, kAXTitleAttribute),
        "description": string(element, kAXDescriptionAttribute),
        "value": string(element, kAXValueAttribute),
    ]
}

func waitForElement(app: AXUIElement, timeout: TimeInterval, predicate: (AXUIElement) -> Bool) -> AXUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let match = descendants(app).first(where: predicate) { return match }
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))
    } while Date() < deadline
    return nil
}

func postEscape(pid: pid_t) {
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    usleep(250_000)
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
    usleep(70_000)
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
if args.count < 4 {
    fputs("usage: native-dialog-ax <pid> <press|escape|inspect> <label-or-stage>\n", stderr)
    exit(64)
}
guard let pid = pid_t(args[1]) else { exit(64) }
let action = args[2]
let label = args[3]
let trusted = AXIsProcessTrusted()
let app = AXUIElementCreateApplication(pid)

if action == "inspect" {
    let nodes = descendants(app)
    let payload: [String: Any] = [
        "trusted": trusted,
        "pid": pid,
        "label": label,
        "nodes": nodes.map(description),
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(trusted ? 0 : 77)
}

guard trusted else {
    fputs("Accessibility permission is not granted\n", stderr)
    exit(77)
}

if action == "escape" {
    guard waitForElement(app: app, timeout: 10, predicate: { element in
        let role = string(element, kAXRoleAttribute)
        let title = string(element, kAXTitleAttribute)
        return (role == kAXSheetRole as String || role == kAXWindowRole as String) && (title.contains(label) || label == "*")
    }) != nil else {
        fputs("No matching sheet/window for escape: \(label)\n", stderr)
        exit(2)
    }
    postEscape(pid: pid)
    print("ESCAPE_SENT \(label)")
    exit(0)
}

guard action == "press" else { exit(64) }
guard let button = waitForElement(app: app, timeout: 10, predicate: { element in
    guard string(element, kAXRoleAttribute) == kAXButtonRole as String else { return false }
    let candidates = [
        string(element, kAXTitleAttribute),
        string(element, kAXDescriptionAttribute),
        string(element, kAXValueAttribute),
    ]
    return candidates.contains(where: { $0 == label })
}) else {
    let payload = descendants(app).map(description)
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    fputs("No AX button \(label). Tree:\n\(String(decoding: data, as: UTF8.self))\n", stderr)
    exit(2)
}
let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
guard result == .success else {
    fputs("AXPress failed: \(result.rawValue)\n", stderr)
    exit(3)
}
print("PRESSED \(label)")
