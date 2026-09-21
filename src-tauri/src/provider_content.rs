use crate::{
    error::NativeError,
    filesystem::{availability::require_content_ready, Filesystem},
    ssh::SshManager,
};
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Arc,
};

pub enum ContentStream {
    Local(File),
    Sftp(ssh2::File),
}

impl Read for ContentStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Local(file) => file.read(buffer),
            Self::Sftp(file) => file.read(buffer),
        }
    }
}

impl Seek for ContentStream {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        match self {
            Self::Local(file) => file.seek(position),
            Self::Sftp(file) => file.seek(position),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContentMetadata {
    pub provider_id: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct ContentSource {
    metadata: ContentMetadata,
    local_path: Option<PathBuf>,
}

impl ContentSource {
    pub fn open(
        filesystem: &Filesystem,
        ssh: &Arc<SshManager>,
        provider_id: Option<&str>,
        requested: &str,
    ) -> Result<Self, NativeError> {
        let provider_id = provider_id.unwrap_or("local");
        if provider_id == "local" {
            let real = require_content_ready(filesystem, Some(provider_id), requested)?;
            let metadata = fs::metadata(&real).map_err(|error| {
                NativeError::from_io(&error, "Unable to inspect content")
                    .with_path(&real)
                    .with_native_error(error.to_string())
            })?;
            if !metadata.is_file() {
                return Err(NativeError::new(
                    "ENOTFILE",
                    "The requested path is not a file",
                ));
            }
            return Ok(Self {
                metadata: ContentMetadata {
                    provider_id: provider_id.to_string(),
                    path: requested.to_string(),
                    size: metadata.len(),
                },
                local_path: Some(real),
            });
        }
        if !provider_id.starts_with("sftp:") {
            return Err(NativeError::new(
                "EFILESYSTEM_ID",
                "This filesystem is not available",
            ));
        }
        let (path, size) = ssh.content_metadata(provider_id, requested)?;
        Ok(Self {
            metadata: ContentMetadata {
                provider_id: provider_id.to_string(),
                path,
                size,
            },
            local_path: None,
        })
    }

    pub fn metadata(&self) -> &ContentMetadata {
        &self.metadata
    }

    pub fn copy_range<W: Write>(
        &self,
        ssh: &Arc<SshManager>,
        start: u64,
        length: u64,
        writer: &mut W,
    ) -> Result<u64, NativeError> {
        if start > self.metadata.size || length > self.metadata.size.saturating_sub(start) {
            return Err(NativeError::new("ERANGE", "Invalid byte range"));
        }
        let mut stream = self.open_stream(ssh)?;
        stream.seek(SeekFrom::Start(start)).map_err(|error| {
            NativeError::from_io(&error, "Unable to seek content")
                .with_path(&self.metadata.path)
                .with_native_error(error.to_string())
        })?;
        io::copy(&mut stream.take(length), writer).map_err(|error| {
            NativeError::from_io(&error, "Unable to stream content")
                .with_path(&self.metadata.path)
                .with_native_error(error.to_string())
        })
    }

    pub fn open_stream(&self, ssh: &Arc<SshManager>) -> Result<ContentStream, NativeError> {
        if let Some(path) = &self.local_path {
            return File::open(path).map(ContentStream::Local).map_err(|error| {
                NativeError::from_io(&error, "Unable to open content")
                    .with_path(path)
                    .with_native_error(error.to_string())
            });
        }
        ssh.open_content_stream(&self.metadata.provider_id, &self.metadata.path)
            .map(ContentStream::Sftp)
    }

    pub fn read_range(
        &self,
        ssh: &Arc<SshManager>,
        start: u64,
        length: u64,
    ) -> Result<Vec<u8>, NativeError> {
        let capacity = usize::try_from(length)
            .map_err(|_| NativeError::new("EOVERFLOW", "Requested range is too large"))?;
        let mut bytes = Vec::with_capacity(capacity);
        let copied = self.copy_range(ssh, start, length, &mut bytes)?;
        if copied != length {
            return Err(NativeError::new(
                "EUNEXPECTED_EOF",
                format!("Expected {length} content bytes, received {copied}"),
            ));
        }
        Ok(bytes)
    }
}
