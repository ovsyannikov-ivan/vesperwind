use serde::Serialize;
use std::{io, path::Path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_error: Option<String>,
}

impl NativeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            path: None,
            native_error: None,
        }
    }

    pub fn with_path(mut self, path: impl AsRef<Path>) -> Self {
        self.path = Some(path.as_ref().to_string_lossy().into_owned());
        self
    }

    pub fn with_native_error(mut self, error: impl Into<String>) -> Self {
        self.native_error = Some(error.into());
        self
    }

    pub fn from_io(error: &io::Error, fallback: &str) -> Self {
        let code = match error.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::AlreadyExists => "EEXIST",
            io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => "EINVAL",
            io::ErrorKind::NotADirectory => "ENOTDIR",
            io::ErrorKind::IsADirectory => "EISDIR",
            io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
            _ => "EIO",
        };

        Self::new(code, fallback)
    }
}
