use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

// Frontend event fired when the user asks for a new note from the tray. The
// webview listens (desktop.js) and runs the same handleNew() the in-app button
// does. Global-shortcut new-note is registered on the JS side and calls
// handleNew() directly, so it needs no event.
const EVENT_NEW_NOTE: &str = "wren://new-note";

// Fired at Quit so every webview (main app + any open sticky) can flush a pending
// 500ms debounced save before the process exits. Must match EVENT_FLUSH_SAVES in
// src/desktop.js / src/sticky-app.js.
const EVENT_FLUSH_SAVES: &str = "wren://flush-saves";

// How long to wait after the flush event before exiting — long enough for a
// webview to run its debounced save through the File System Access / Tauri fs
// write, short enough not to feel laggy.
const FLUSH_GRACE_MS: u64 = 600;

// The main window ships `"visible": false` so the first painted frame already
// has content; the frontend calls window.show() once it has mounted
// (revealWindow() in app-controller.js, with a 3s belt-and-braces timeout).
// That makes the ONLY path to a visible app a working JS bundle: a broken or
// partially-downloaded frontend leaves Wren running with no window at all and
// no way to get one back except the tray. This is the Rust-side backstop —
// if the window is still hidden this long after setup, show it regardless, so
// the worst case is an app showing an error rather than an invisible process
// (audit T5).
const REVEAL_FALLBACK_MS: u64 = 5_000;

/// Show, un-minimize, and focus the main window (bringing it back from the tray).
#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
  if let Some(w) = app.get_webview_window("main") {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
  }
}

/// Toggle visibility of ALL Wren windows (main + any floating stickies), keyed
/// off the main window's current visibility. Hidden → show all and focus main;
/// visible → hide all (back to the tray).
#[cfg(desktop)]
fn toggle_all(app: &tauri::AppHandle) {
  let main_visible = app
    .get_webview_window("main")
    .and_then(|w| w.is_visible().ok())
    .unwrap_or(false);
  if main_visible {
    for (_label, w) in app.webview_windows() {
      let _ = w.hide();
    }
  } else {
    for (_label, w) in app.webview_windows() {
      let _ = w.show();
    }
    show_main(app);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  // Single-instance MUST be registered first in Tauri v2. A second `Wren.exe`
  // is routed here instead of opening a duplicate window; we surface the
  // existing instance (it may be hidden in the tray) by showing + focusing it.
  #[cfg(desktop)]
  {
    builder = builder
      .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main(app);
      }))
      // Global quick-capture hotkeys. The plugin only needs initializing here;
      // the actual combos are registered from the frontend (desktop.js) so they
      // can be rebound and fail soft without a recompile.
      .plugin(tauri_plugin_global_shortcut::Builder::new().build())
      // Launch-at-login. Off by default; the frontend toggle enables/disables
      // the OS login item via the plugin's JS API.
      .plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None::<Vec<&str>>,
      ));
  }

  builder
    // System-browser opener (used by the app footer links so the EXE never
    // navigates the app window when a link is clicked).
    .plugin(tauri_plugin_opener::init())
    // Desktop notifications for due/overdue notes (Note Lifecycle A3). The
    // frontend (desktop.js) checks permission and fires the notification.
    .plugin(tauri_plugin_notification::init())
    // Native filesystem access for the local notes folder. TauriFsAdapter reads
    // and writes <Documents>/Wren Notes through this plugin (scope is defined in
    // capabilities/default.json — without it, fs calls fail silently).
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // ---- System tray (P1) ------------------------------------------------
      // Tray menu: New note / Show-hide all / Quit. Desktop only.
      #[cfg(desktop)]
      {
        let new_note = MenuItem::with_id(app, "new_note", "New note", true, None::<&str>)?;
        let toggle = MenuItem::with_id(app, "toggle", "Show / hide all", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&new_note, &toggle, &sep, &quit])?;

        let mut tray = TrayIconBuilder::with_id("wren-tray")
          .tooltip("Wren")
          .menu(&menu)
          .show_menu_on_left_click(false)
          .on_menu_event(|app, event| match event.id.as_ref() {
            "new_note" => {
              show_main(app);
              let _ = app.emit(EVENT_NEW_NOTE, ());
            }
            "toggle" => toggle_all(app),
            "quit" => {
              // Ask every webview to flush a pending debounced save, then exit
              // after a short grace period so the write can land (audit T2).
              let _ = app.emit(EVENT_FLUSH_SAVES, ());
              let handle = app.clone();
              std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(FLUSH_GRACE_MS));
                handle.exit(0);
              });
            }
            _ => {}
          })
          .on_tray_icon_event(|tray, event| {
            // Left-click the tray icon toggles the windows (Windows-typical).
            if let TrayIconEvent::Click {
              button: MouseButton::Left,
              button_state: MouseButtonState::Up,
              ..
            } = event
            {
              toggle_all(tray.app_handle());
            }
          });
        if let Some(icon) = app.default_window_icon() {
          tray = tray.icon(icon.clone());
        }
        tray.build(app)?;

        // ---- Hide-to-tray (P1) --------------------------------------------
        // Closing the MAIN window hides it to the tray instead of quitting, so
        // Wren stays a keystroke away. (Sticky windows keep normal close.)
        if let Some(main) = app.get_webview_window("main") {
          let main_for_event = main.clone();
          main.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
              api.prevent_close();
              let _ = main_for_event.hide();
            }
          });
        }
      }

      // ---- Reveal fallback (audit T5) ------------------------------------
      #[cfg(desktop)]
      {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_millis(REVEAL_FALLBACK_MS));
          if let Some(w) = handle.get_webview_window("main") {
            // is_visible() errs on a destroyed window; treat that as "nothing
            // to reveal" rather than forcing a show on a window that is gone.
            if let Ok(false) = w.is_visible() {
              log::warn!(
                "main window still hidden {REVEAL_FALLBACK_MS}ms after setup - \
                 revealing from Rust (frontend never called show())"
              );
              let _ = w.show();
              let _ = w.set_focus();
            }
          }
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
