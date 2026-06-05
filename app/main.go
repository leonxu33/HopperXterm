package main

import (
	"embed"
	goruntime "runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	app := NewApp()

	// Window sizing:
	//   Default 1440×900 — comfortable for sidebar + ~110-column terminal
	//   plus headroom to open the right panel without resizing.
	//   Minimum 900×560 — the floor before the layout starts to collide:
	//     sidebar(200) + ~380 pane grid + right panel(240) ≈ 900
	//     topchrome(38) + tabs(42) + status(34) + ~360 terminal ≈ 560
	//
	// Window chrome is per-OS:
	//   - Windows/Linux: Frameless — the OS title bar is suppressed and the
	//     WebView fills the whole window. TopChrome.tsx draws the title bar
	//     (brand, quick-connect, gear) plus our own min/max/close controls and
	//     owns the window-drag region via the `--wails-draggable` CSS property.
	//     Wails still services edge-resize hit-testing in frameless mode.
	//     (Windows 11's DWM rounds the frameless window's corners itself.)
	//   - macOS: NOT frameless. A borderless NSWindow has square corners and
	//     no shadow (macOS only rounds titled windows), which broke the app's
	//     rounded-corner design. Instead: a titled window with a hidden-inset
	//     titlebar (transparent titlebar + full-size content) — native rounded
	//     corners, native shadow, and the real traffic lights top-left.
	//     TopChrome skips its custom window controls on mac and insets the
	//     brand to clear the lights.
	// macOS needs an app menu with the Edit role: WKWebView routes Cmd+C/V/X/A
	// through the menu's key equivalents, so without an Edit menu NO text field
	// in the app can copy/paste via the keyboard. Windows/Linux get no menu
	// (nil) — the frameless window has no menu bar to show one in anyway.
	var appMenu *menu.Menu
	if goruntime.GOOS == "darwin" {
		appMenu = menu.NewMenu()
		appMenu.Append(menu.AppMenu())  // standard About / Hide / Quit (Cmd+Q)
		appMenu.Append(menu.EditMenu()) // Cmd+C/V/X/A for the WebView
	}

	err := wails.Run(&options.App{
		Title:     "HopperXterm",
		Frameless: goruntime.GOOS != "darwin",
		Menu:      appMenu,
		Mac: &mac.Options{
			TitleBar:   mac.TitleBarHiddenInset(),
			Appearance: mac.NSAppearanceNameDarkAqua,
		},
		Width:     1440,
		Height:    900,
		MinWidth:  900,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		// EnableFileDrop surfaces dropped-in OS files' absolute paths to the
		// frontend via runtime.OnFileDrop. The SFTP file browser uses it to
		// upload files dragged from Explorer/Finder onto the listing.
		// useDropTarget (frontend side) scopes drops to elements marked with
		// the default CSS property "--wails-drop-target: drop".
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
