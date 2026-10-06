mod commands;
mod content;
mod error;
mod filesystem;
mod media;
#[cfg(debug_assertions)]
mod media_ui_regression;
mod mpv;
#[cfg(debug_assertions)]
mod native_regression;
mod office;
mod provider_content;
mod settings;
mod shell_integration;
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

pub use filesystem::jobs::run_filesystem_helper;

pub struct AppState {
    filesystem: Arc<Filesystem>,
    operation_jobs: Arc<filesystem::jobs::OperationJobs>,
    conversion: Arc<office::ConversionBroker>,
    content: Arc<ContentManager>,
    media_http: Arc<media::http::MediaHttpServer>,
    settings: Arc<SettingsStore>,
    terminal: Arc<TerminalManager>,
    ssh: Arc<SshManager>,
    player: Arc<mpv::MpvPlayerManager>,
    thumbnails: Arc<media::thumbnail::ThumbnailManager>,
    web_history: Arc<media::history::WebHistory>,
    directory_watches: filesystem::watch::DirectoryWatches,
    search_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    archive_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    shell: Arc<shell_integration::ShellIntegration>,
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
    let thumbnails = Arc::new(media::thumbnail::ThumbnailManager::default());
    let shutdown_thumbnails = Arc::clone(&thumbnails);
    let player = mpv::MpvPlayerManager::new(Arc::clone(&ssh), Arc::clone(&thumbnails));
    let shutdown_history = Arc::clone(&player.history);
    let web_history = Arc::new(media::history::WebHistory::new(Arc::clone(&player.history)));
    let shutdown_web_history = Arc::clone(&web_history);
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
    #[cfg(debug_assertions)]
    if media_ui_regression::config().is_some() {
        // The acceptance app must never change the user's WebView storage.
        context.config_mut().identifier = "com.vesperwind.media-acceptance".into();
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
            window.background_throttling =
                Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
        }
    }
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

    let builder = tauri::Builder::default().plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::SIZE
                    | tauri_plugin_window_state::StateFlags::POSITION
                    | tauri_plugin_window_state::StateFlags::MAXIMIZED,
            )
            .with_filter(|label| label == "main")
            .build(),
    );
    #[cfg(debug_assertions)]
    let builder = builder.on_page_load(media_ui_regression::page_loaded);
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
            operation_jobs: Arc::new(filesystem::jobs::OperationJobs::default()),
            conversion: Arc::new(office::ConversionBroker::default()),
            filesystem,
            content,
            media_http,
            settings,
            terminal,
            ssh: Arc::clone(&ssh),
            player,
            thumbnails,
            web_history,
            directory_watches: filesystem::watch::DirectoryWatches::default(),
            search_jobs: Arc::new(Mutex::new(HashMap::new())),
            archive_jobs: Arc::new(Mutex::new(HashMap::new())),
            shell: Arc::new(shell_integration::ShellIntegration::default()),
        })
        .setup(move |app| {
            let history_path = app.path().app_data_dir()?.join("media-history.sqlite3");
            #[cfg(debug_assertions)]
            let history_path = media_ui_regression::history_path().unwrap_or(history_path);
            app.state::<AppState>()
                .player
                .history
                .configure(history_path);
            app.state::<AppState>()
                .shell
                .setup(app.handle(), Arc::clone(&app.state::<AppState>().ssh));
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
            #[cfg(debug_assertions)]
            {
                if std::env::args().nth(1).as_deref() == Some("--native-regression") {
                    window.hide()?;
                }
                if media_ui_regression::config().is_some() {
                    window.show()?;
                    window.set_focus()?;
                }
                media_ui_regression::setup(app.handle());
                native_regression::start(app.handle());
            }
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
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                commands::filesystem::filesystem_root,
                commands::archive::archive_start,
                commands::archive::archive_cancel,
                commands::filesystem::filesystem_resolve_location,
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
                commands::document::document_cancel,
                commands::filesystem::filesystem_operate,
                commands::filesystem::filesystem_operation_cancel,
                commands::desktop::desktop_operate,
                commands::content::content_prepare,
                commands::content::content_status,
                commands::content::content_cancel,
                commands::runtime::runtime_info,
                commands::media::media_source,
                commands::media::video_thumbnail,
                commands::media::media_history,
                commands::media::media_chapters,
                commands::media::media_metadata,
                commands::media::media_cancel_metadata,
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
                commands::player::player_set_transition_cover,
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
                commands::shell::clipboard_write,
                commands::shell::clipboard_read,
                commands::shell::clipboard_consume,
                commands::shell::drop_read,
                commands::shell::drag_start,
                commands::shell::disk_image_operate,
                commands::shell::shell_capabilities,
            ];
            move |invoke| {
                if invoke
                    .message
                    .webview()
                    .label()
                    .starts_with("office-converter-")
                {
                    invoke
                        .resolver
                        .reject("IPC is disabled in the isolated Office converter");
                    true
                } else {
                    handler(invoke)
                }
            }
        })
        .build(context)
        .expect("error while running Vesperwind");

    app.run(move |app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            for cancel in app_handle
                .state::<AppState>()
                .archive_jobs
                .lock()
                .unwrap()
                .values()
            {
                cancel.store(true, std::sync::atomic::Ordering::Release);
            }
            app_handle.state::<AppState>().conversion.shutdown();
            app_handle.state::<AppState>().shell.shutdown();
            app_handle.state::<AppState>().operation_jobs.shutdown();
            shutdown_terminal.shutdown();
            shutdown_player.close_all();
            shutdown_thumbnails.shutdown();
            shutdown_web_history.close_all();
            shutdown_history.flush();
            ssh.shutdown();
            // Allow cancelled archive workers to kill/reap their child and
            // remove staging before normal application shutdown finishes.
            let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
            while !app_handle
                .state::<AppState>()
                .archive_jobs
                .lock()
                .unwrap()
                .is_empty()
                && std::time::Instant::now() < until
            {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    });
}

/// Video alone creates the child controls WebView. Audio never calls this.
pub(crate) fn ensure_media_overlay(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview("media-overlay").is_some() {
        return Ok(());
    }
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    let overlay_builder = tauri::webview::WebviewBuilder::new(
        "media-overlay",
        tauri::WebviewUrl::App("media-overlay.html".into()),
    )
    .transparent(true)
    .focused(false);
    #[cfg(debug_assertions)]
    let overlay_builder = if media_ui_regression::config().is_some() {
        overlay_builder
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    } else {
        overlay_builder
    };
    let overlay = window
        .add_child(
            overlay_builder,
            tauri::LogicalPosition::new(-10_000.0, -10_000.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|error| error.to_string())?;
    // Do not call Webview::hide for a child webview here. On macOS/Wry
    // that operation can hide the parent native window as well. An
    // inactive transparent overlay is parked outside the content area.
    drop(overlay);
    Ok(())
}
