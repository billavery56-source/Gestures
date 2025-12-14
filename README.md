# Mouse Gestures Extension

**A browser extension that lets you control your browser with customizable mouse gestures, including gesture trails, per-site enable/disable, and import/export of gesture settings.**

## Features
- Draw mouse gestures with the right mouse button to trigger browser actions
- Visual gesture trail for feedback
- Default gestures for navigation, tab management, and scrolling
- Customize, add, or remove gesture mappings
- Enable or disable gestures per website
- Import/export gesture settings for backup or sharing
- Adjustable gesture sensitivity
- Ignores gestures on input fields for convenience

## Installation
1. Clone or download this repository.
2. Open `chrome://extensions` in your browser.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select the project folder.

## Usage
- Right-click and drag to draw a gesture on any webpage.
- Release the mouse to trigger the mapped action.
- Click the extension icon to open the popup:
  - Enable/disable gestures for the current site
  - View, edit, or add gesture mappings
  - Adjust gesture sensitivity
  - Import/export your gesture settings
  - Click the help icon for detailed instructions

## Default Gestures
- **L**: Back
- **R**: Forward
- **U**: Scroll Up
- **D**: Scroll Down
- **DL**: Close Tab
- **DR**: Reload Tab
- **UR**: New Tab
- **UL**: Previous Tab
- **RD**: Next Tab

## Development
- Content scripts are in `scripts/`
- Popup UI is in `popup.html` and `scripts/popup.js`
- Gesture logic and settings are in `scripts/gestures.js`, `gestureMappings.js`, and `gestureSettings.js`
- Manifest is in `manifest.json`

## License
MIT
