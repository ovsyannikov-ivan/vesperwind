mod commands;
mod content;
mod error;
mod filesystem;
mod media;
mod mpv;
mod provider_content;
mod settings;
mod ssh;
mod terminal;
#[cfg(test)]
mod test_support;

use content::ContentManager;
use filesystem::Filesystem;
use settings::SettingsStore;
use ssh::SshManager;
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
#[cfg(not(target_os = "windows"))]
use tauri::menu::Menu;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItem, MenuItemKind, PredefinedMenuItem};
#[cfg(not(target_os = "windows"))]
use tauri::Emitter;
use tauri::Manager;
use terminal::TerminalManager;

pub struct AppState {
    filesystem: Arc<Filesystem>,
    content: Arc<ContentManager>,
    media_http: Arc<media::http::MediaHttpServer>,
    settings: Arc<SettingsStore>,
    terminal: Arc<TerminalManager>,
    ssh: Arc<SshManager>,
    player: Arc<mpv::MpvPlayerManager>,
    directory_watches: filesystem::watch::DirectoryWatches,
    search_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!(
        "Vesperwind {} | Tauri build: {} | Git commit: {}",
        env!("CARGO_PKG_VERSION"),
        env!("VESPERWIND_BUILD_TIMESTAMP"),
        env!("VESPERWIND_GIT_SHA")
    );
    let filesystem = Arc::new(Filesystem::from_environment().unwrap_or_else(|error| {
        panic!(
            "Unable to initialize Vesperwind filesystem: {}",
            error.message
        )
    }));
    let settings = Arc::new(SettingsStore::from_environment().unwrap_or_else(|error| {
        panic!(
            "Unable to initialize Vesperwind settings: {}",
            error.message
        )
    }));
    let terminal = TerminalManager::new();
    let ssh = SshManager::new();
    let content = ContentManager::new();
    let media_http = media::http::MediaHttpServer::start(Arc::clone(&filesystem), Arc::clone(&ssh))
        .expect("Unable to start the local media server");
    let player = mpv::MpvPlayerManager::new(Arc::clone(&ssh));
    let shutdown_terminal = Arc::clone(&terminal);
    let shutdown_player = Arc::clone(&player);
    let media_filesystem = Arc::clone(&filesystem);
    let media_ssh = Arc::clone(&ssh);

    // The native window and WebView need a background before HTML/CSS can paint.
    let startup_theme = settings.load().ok().and_then(|value| {
        match value
            .pointer("/appearance/theme")
            .and_then(|theme| theme.as_str())
        {
            Some("light") => Some(tauri::Theme::Light),
            Some("dark") => Some(tauri::Theme::Dark),
            _ => None,
        }
    });
    let mut context = tauri::generate_context!();
    if startup_theme == Some(tauri::Theme::Light) {
        if let Some(window) = context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == "main")
        {
            window.background_color = Some(tauri::window::Color(242, 242, 242, 255));
        }
    }

    let builder = tauri::Builder::default();
    // Windows uses the application's toolbar. Attaching a native menu also
    // leaves it visible in fullscreen and changes the client height. Preserve
    // the existing menus on other platforms, including macOS's system menu.
    #[cfg(not(target_os = "windows"))]
    let builder = builder
        .menu(|app| {
            let menu = Menu::default(app)?;
            #[cfg(target_os = "macos")]
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                let settings = MenuItem::with_id(
                    app,
                    "open-settings",
                    "Settings…",
                    true,
                    Some("CmdOrCtrl+,"),
                )?;
                app_menu.insert(&settings, 2)?;
                app_menu.insert(&PredefinedMenuItem::separator(app)?, 3)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "open-settings" {
                let _ = app.emit("vesperwind:open-settings", ());
            }
        });

    let app = builder
        .manage(AppState {
            filesystem,
            content,
            media_http,
            settings,
            terminal,
            ssh: Arc::clone(&ssh),
            player,
            directory_watches: filesystem::watch::DirectoryWatches::default(),
            search_jobs: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(move |app| {
            let window = app
                .get_window("main")
                .expect("main window must exist before creating media overlay");
            let theme =
                startup_theme.unwrap_or_else(|| window.theme().unwrap_or(tauri::Theme::Dark));
            let background = match theme {
                tauri::Theme::Light => tauri::window::Color(242, 242, 242, 255),
                _ => tauri::window::Color(28, 28, 30, 255),
            };
            window.set_background_color(Some(background))?;
            if let Some(webview) = app.get_webview("main") {
                webview.set_background_color(Some(background))?;
            }
            let overlay = window.add_child(
                tauri::webview::WebviewBuilder::new(
                    "media-overlay",
                    tauri::WebviewUrl::App("media-overlay.html".into()),
                )
                .transparent(true)
                .focused(false),
                tauri::LogicalPosition::new(-10_000.0, -10_000.0),
                tauri::LogicalSize::new(1.0, 1.0),
            )?;
            // Do not call Webview::hide for a child webview here. On macOS/Wry
            // that operation can hide the parent native window as well. An
            // inactive transparent overlay is parked outside the content area.
            drop(overlay);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(
            "vesperwind-media",
            move |_context, request, responder| {
                let filesystem = Arc::clone(&media_filesystem);
                let ssh = Arc::clone(&media_ssh);
                std::thread::spawn(move || {
                    responder.respond(media::serve(&filesystem, &ssh, request));
                });
            },
        )
        .invoke_handler(tauri::generate_handler![
            commands::filesystem::filesystem_root,
            commands::filesystem::filesystem_list,
            commands::filesystem::filesystem_search,
            commands::filesystem::filesystem_search_cancel,
            commands::filesystem::filesystem_watch,
            commands::filesystem::filesystem_unwatch,
            commands::filesystem::filesystem_read_text,
            commands::filesystem::filesystem_write_text,
            commands::filesystem::filesystem_read_binary,
            commands::filesystem::filesystem_write_binary,
            commands::document::document_convert,
            commands::filesystem::filesystem_operate,
            commands::desktop::desktop_operate,
            commands::content::content_prepare,
            commands::content::content_status,
            commands::content::content_cancel,
            commands::runtime::runtime_info,
            commands::media::media_source,
            commands::player::player_capabilities,
            commands::player::player_open,
            commands::player::player_play,
            commands::player::player_pause,
            commands::player::player_seek,
            commands::player::player_set_volume,
            commands::player::player_set_muted,
            commands::player::player_select_track,
            commands::player::player_set_subtitle_delay,
            commands::player::player_set_geometry,
            commands::player::player_set_visible,
            commands::player::player_set_overlay,
            commands::player::player_overlay_snapshot,
            commands::player::player_snapshot,
            commands::player::player_close,
            commands::settings::settings_get,
            commands::settings::settings_update,
            commands::settings::settings_reset,
            commands::terminal::terminal_create,
            commands::terminal::terminal_input,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_status,
        ])
        .build(context)
        .expect("error while running Vesperwind");

    app.run(move |_app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            shutdown_terminal.shutdown();
            shutdown_player.close_all();
            ssh.shutdown();
        }
    });
}
