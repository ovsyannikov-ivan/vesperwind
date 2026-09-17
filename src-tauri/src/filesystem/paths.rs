use super::Filesystem;
use crate::error::NativeError;
use path_clean::PathClean;
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub fn absolute_clean(path: &Path) -> Result<PathBuf, NativeError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| {
                NativeError::from_io(&error, "Unable to resolve the current directory")
            })?
            .join(path)
    };
    Ok(absolute.clean())
}

pub fn resolve_inside_root(
    filesystem: &Filesystem,
    requested: &str,
) -> Result<PathBuf, NativeError> {
    if requested.is_empty() {
        return Err(NativeError::new("EINVAL", "A path is required"));
    }

    let resolved = absolute_clean(Path::new(requested))?;
    if !resolved.starts_with(filesystem.root()) {
        return Err(outside_root());
    }
    Ok(resolved)
}

pub fn verify_existing_inside_root(
    filesystem: &Filesystem,
    resolved: &Path,
) -> Result<PathBuf, NativeError> {
    let real = fs::canonicalize(resolved)
        .map_err(|error| NativeError::from_io(&error, "The requested path is unavailable"))?;
    if !real.starts_with(filesystem.real_root()) {
        return Err(outside_root());
    }
    Ok(real)
}

pub fn outside_root() -> NativeError {
    NativeError::new("EOUTSIDE_ROOT", "Path is outside the configured root")
}
