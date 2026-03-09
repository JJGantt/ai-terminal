import Cocoa

let systemWide = AXUIElementCreateSystemWide()

var focusedApp: AnyObject?
guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute as CFString, &focusedApp) == .success else { exit(0) }

var focusedElement: AnyObject?
guard AXUIElementCopyAttributeValue(focusedApp as! AXUIElement, kAXFocusedUIElementAttribute as CFString, &focusedElement) == .success else { exit(0) }

var selectedText: AnyObject?
guard AXUIElementCopyAttributeValue(focusedElement as! AXUIElement, kAXSelectedTextAttribute as CFString, &selectedText) == .success else { exit(0) }

if let text = selectedText as? String, !text.isEmpty {
    print(text, terminator: "")
}
