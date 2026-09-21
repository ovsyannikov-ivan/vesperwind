use crate::error::NativeError;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const DEFAULT_LS_COLORS: &str = "ExGxFxDxxxExExBxBxExExxA";
const ZSH_STARTUP_FILES: &[&str] = &[".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"];

pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
    zsh_startup_directory: Mutex<Option<PathBuf>>,
}

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    id: String,
    exit_code: u32,
    signal: Option<String>,
}

impl TerminalManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            zsh_startup_directory: Mutex::new(None),
        })
    }

    pub fn create(
        self: &Arc<Self>,
        app: AppHandle,
        cwd: &Path,
        columns: u16,
        rows: u16,
    ) -> Result<(String, bool), NativeError> {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|value| value.into_inner());

        let shell = std::env::var("SHELL").unwrap_or_else(|_| default_shell());
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(terminal_error)?;
        let mut command = CommandBuilder::new(&shell);
        #[cfg(not(windows))]
        command.arg("-l");
        command.cwd(cwd);
        command.env_remove("npm_config_prefix");
        command.env_remove("NPM_CONFIG_PREFIX");
        command.env_remove("PREFIX");
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env(
            "CLICOLOR",
            std::env::var("CLICOLOR").unwrap_or_else(|_| "1".into()),
        );
        command.env(
            "LSCOLORS",
            std::env::var("LSCOLORS").unwrap_or_else(|_| DEFAULT_LS_COLORS.into()),
        );

        if Path::new(&shell)
            .file_name()
            .is_some_and(|name| name == "zsh")
        {
            command.env("ZDOTDIR", self.ensure_zsh_startup_directory()?);
        }

        let mut child = pair.slave.spawn_command(command).map_err(terminal_error)?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(terminal_error)?;
        let writer = pair.master.take_writer().map_err(terminal_error)?;
        let id = Uuid::new_v4().to_string();
        sessions.insert(
            id.clone(),
            TerminalSession {
                writer,
                master: pair.master,
                killer,
            },
        );
        drop(sessions);

        let output_id = id.clone();
        let output_app = app.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 16 * 1024];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => {
                        if !pending.is_empty() {
                            emit_output(
                                &output_app,
                                &output_id,
                                String::from_utf8_lossy(&pending).into_owned(),
                            );
                        }
                        break;
                    }
                    Ok(length) => {
                        pending.extend_from_slice(&buffer[..length]);
                        match std::str::from_utf8(&pending) {
                            Ok(data) => {
                                emit_output(&output_app, &output_id, data.to_string());
                                pending.clear();
                            }
                            Err(error) if error.error_len().is_none() => {
                                let valid_length = error.valid_up_to();
                                if valid_length > 0 {
                                    let data = String::from_utf8_lossy(&pending[..valid_length])
                                        .into_owned();
                                    emit_output(&output_app, &output_id, data);
                                    pending.drain(..valid_length);
                                }
                            }
                            Err(_) => {
                                let data = String::from_utf8_lossy(&pending).into_owned();
                                emit_output(&output_app, &output_id, data);
                                pending.clear();
                            }
                        }
                    }
                }
            }
        });

        let manager = Arc::clone(self);
        let exit_id = id.clone();
        thread::spawn(move || {
            let status = child.wait();
            manager.clear_if_active(&exit_id);
            let (exit_code, signal) = match status {
                Ok(status) => (status.exit_code(), None),
                Err(error) => (1, Some(error.to_string())),
            };
            let _ = app.emit(
                "terminal:exit",
                TerminalExit {
                    id: exit_id,
                    exit_code,
                    signal,
                },
            );
        });

        Ok((id, false))
    }

    pub fn write(&self, id: &str, data: &str) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(active) = sessions.get_mut(id) {
            let _ = active.writer.write_all(data.as_bytes());
            let _ = active.writer.flush();
        }
    }

    pub fn resize(&self, id: &str, columns: u16, rows: u16) {
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(active) = sessions.get(id) {
            let _ = active.master.resize(PtySize {
                rows,
                cols: columns,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn close(&self, id: Option<&str>) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(id) = id {
            if let Some(mut active) = sessions.remove(id) {
                let _ = active.killer.kill();
            }
        } else {
            for (_, mut active) in sessions.drain() {
                let _ = active.killer.kill();
            }
        }
    }

    pub fn shutdown(&self) {
        self.close(None);
        if let Some(directory) = self
            .zsh_startup_directory
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .take()
        {
            let _ = fs::remove_dir_all(directory);
        }
    }

    fn clear_if_active(&self, id: &str) {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        sessions.remove(id);
    }

    fn ensure_zsh_startup_directory(&self) -> Result<PathBuf, NativeError> {
        let mut directory = self
            .zsh_startup_directory
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(existing) = directory.as_ref() {
            return Ok(existing.clone());
        }

        let original = std::env::var("ZDOTDIR")
            .or_else(|_| std::env::var("HOME"))
            .map(PathBuf::from)
            .or_else(|_| dirs::home_dir().ok_or(std::env::VarError::NotPresent))
            .map_err(|_| NativeError::new("ETERMINAL", "Unable to locate zsh configuration"))?;
        let created = std::env::temp_dir().join(format!("vesperwind-zsh-{}", Uuid::new_v4()));
        fs::create_dir(&created)
            .map_err(|error| NativeError::from_io(&error, "Unable to prepare zsh"))?;
        for filename in ZSH_STARTUP_FILES {
            fs::write(
                created.join(filename),
                zsh_startup_file(&original, filename),
            )
            .map_err(|error| NativeError::from_io(&error, "Unable to prepare zsh"))?;
        }
        *directory = Some(created.clone());
        Ok(created)
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn zsh_startup_file(original: &Path, filename: &str) -> String {
    let original_file = original.join(filename);
    let quoted_original = quote_zsh(&original.to_string_lossy());
    let quoted_file = quote_zsh(&original_file.to_string_lossy());
    let source = format!(
        "if [[ -r {quoted_file} ]]; then\n  __vesperwind_zdotdir=\"$ZDOTDIR\"\n  ZDOTDIR={quoted_original}\n  builtin source {quoted_file}\n  ZDOTDIR=\"$__vesperwind_zdotdir\"\n  unset __vesperwind_zdotdir\nfi\n"
    );
    if filename == ".zshrc" || filename == ".zlogin" {
        format!(
            "{source}\nif [[ \"$PROMPT\" == '%n@%m %1~ %# ' ]]; then\n  PROMPT='%F{{green}}%n@%m%f %F{{blue}}%1~%f %# '\nfi\n"
        )
    } else {
        source
    }
}

fn quote_zsh(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn emit_output(app: &AppHandle, id: &str, data: String) {
    let _ = app.emit(
        "terminal:output",
        TerminalOutput {
            id: id.to_string(),
            data,
        },
    );
}

fn default_shell() -> String {
    if cfg!(windows) {
        "powershell.exe".to_string()
    } else {
        "/bin/zsh".to_string()
    }
}

fn terminal_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::new("ETERMINAL", error.to_string())
}
