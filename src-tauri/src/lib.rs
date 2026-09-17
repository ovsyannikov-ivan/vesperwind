mod commands;
mod content;
mod error;
mod filesystem;
mod media;
mod settings;
mod terminal;

use content::ContentManager;
use filesystem::Filesystem;
use settings::SettingsStore;
use std::sync::Arc;
use terminal::TerminalManager;

pub struct AppState {
    filesystem: Arc<Filesystem>,
    content: Arc<ContentManager>,
    media_http: Arc<media::http::MediaHttpServer>,
    settings: Arc<SettingsStore>,
    terminal: Arc<TerminalManager>,
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
    let content = ContentManager::new();
    let media_http = media::http::MediaHttpServer::start(Arc::clone(&filesystem))
        .expect("Unable to start the local media server");
    let shutdown_terminal = Arc::clone(&terminal);
    let media_filesystem = Arc::clone(&filesystem);

    let app = tauri::Builder::default()
        .manage(AppState {
            filesystem,
            content,
            media_http,
            settings,
            terminal,
        })
        .register_asynchronous_uri_scheme_protocol(
            "vesperwind-media",
            move |_context, request, responder| {
                let filesystem = Arc::clone(&media_filesystem);
                std::thread::spawn(move || {
                    responder.respond(media::serve(&filesystem, request));
                });
            },
        )
        .invoke_handler(tauri::generate_handler![
            commands::filesystem::filesystem_root,
            commands::filesystem::filesystem_list,
            commands::filesystem::filesystem_read_text,
            commands::filesystem::filesystem_write_text,
            commands::filesystem::filesystem_operate,
            commands::content::content_prepare,
            commands::content::content_status,
            commands::content::content_cancel,
            commands::runtime::runtime_info,
            commands::media::media_source,
            commands::settings::settings_get,
            commands::settings::settings_update,
            commands::settings::settings_reset,
            commands::terminal::terminal_create,
            commands::terminal::terminal_input,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Vesperwind");

    app.run(move |_app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            shutdown_terminal.shutdown();
        }
    });
}
