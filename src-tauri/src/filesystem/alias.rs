use crate::error::NativeError;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::{rc::autoreleasepool, runtime::AnyObject};
    use objc2_foundation::{
        NSNumber, NSString, NSURLBookmarkResolutionOptions, NSURLIsAliasFileKey, NSURL,
    };
    use std::collections::HashSet;

    const MAX_ALIAS_DEPTH: usize = 32;

    fn file_url(path: &Path) -> objc2::rc::Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    pub(super) fn is_alias(path: &Path) -> Result<bool, NativeError> {
        autoreleasepool(|_| {
            let url = file_url(path);
            let mut value: Option<objc2::rc::Retained<AnyObject>> = None;
            // SAFETY: Foundation specifies NSNumber for NSURLIsAliasFileKey;
            // the dynamic downcast below still validates the returned type.
            unsafe { url.getResourceValue_forKey_error(&mut value, NSURLIsAliasFileKey) }.map_err(
                |error| {
                    alias_error(
                        "EALIAS_INSPECT",
                        "Unable to inspect Finder Alias",
                        path,
                        &error,
                    )
                },
            )?;
            Ok(value
                .and_then(|value| value.downcast::<NSNumber>().ok())
                .is_some_and(|value| value.boolValue()))
        })
    }

    pub(super) fn resolve(path: &Path) -> Result<PathBuf, NativeError> {
        autoreleasepool(|_| {
            let mut current = path.to_path_buf();
            let mut visited = HashSet::new();

            for _ in 0..MAX_ALIAS_DEPTH {
                if !is_alias(&current)? {
                    return Ok(current);
                }
                if !visited.insert(current.clone()) {
                    return Err(NativeError::new(
                        "EALIAS_LOOP",
                        "Finder Alias resolution loop detected",
                    )
                    .with_path(path));
                }

                let url = file_url(&current);
                let options = NSURLBookmarkResolutionOptions::WithoutUI
                    | NSURLBookmarkResolutionOptions::WithoutMounting;
                let target = NSURL::URLByResolvingAliasFileAtURL_options_error(&url, options)
                    .map_err(|error| {
                        alias_error(
                            "EALIAS_BROKEN",
                            "The Finder Alias target is unavailable",
                            path,
                            &error,
                        )
                    })?;
                let target_path = target.path().ok_or_else(|| {
                    NativeError::new("EALIAS_BROKEN", "The Finder Alias target is unavailable")
                        .with_path(path)
                })?;
                let next = PathBuf::from(target_path.to_string());
                if next == current || visited.contains(&next) {
                    return Err(NativeError::new(
                        "EALIAS_LOOP",
                        "Finder Alias resolution loop detected",
                    )
                    .with_path(path));
                }
                current = next;
            }

            Err(NativeError::new(
                "EALIAS_LOOP",
                "Finder Alias resolution exceeded the safe depth",
            )
            .with_path(path))
        })
    }

    fn alias_error(
        code: &str,
        message: &str,
        path: &Path,
        error: &objc2_foundation::NSError,
    ) -> NativeError {
        NativeError::new(code, message)
            .with_path(path)
            .with_native_error(format!(
                "domain={} code={} description={}",
                error.domain(),
                error.code(),
                error.localizedDescription()
            ))
    }
}

#[cfg(target_os = "macos")]
pub fn is_finder_alias(path: &Path) -> Result<bool, NativeError> {
    platform::is_alias(path)
}

#[cfg(not(target_os = "macos"))]
pub fn is_finder_alias(_path: &Path) -> Result<bool, NativeError> {
    Ok(false)
}

#[cfg(target_os = "macos")]
pub fn resolve_finder_alias(path: &Path) -> Result<PathBuf, NativeError> {
    platform::resolve(path)
}

#[cfg(not(target_os = "macos"))]
pub fn resolve_finder_alias(path: &Path) -> Result<PathBuf, NativeError> {
    Ok(path.to_path_buf())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{is_finder_alias, resolve_finder_alias};
    use objc2_foundation::{
        NSString, NSURLBookmarkCreationOptions, NSURLBookmarkFileCreationOptions, NSURL,
    };
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    fn file_url(path: &std::path::Path) -> objc2::rc::Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    #[test]
    fn detects_and_resolves_foundation_alias_file() {
        let root = std::env::temp_dir().join(format!("vesperwind-alias-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("movie.mkv");
        let alias = root.join("Movie alias.mkv");
        fs::write(&target, b"not bookmark bytes").unwrap();

        let target_url = file_url(&target);
        let data = target_url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::SuitableForBookmarkFile,
                None,
                None,
            )
            .unwrap();
        NSURL::writeBookmarkData_toURL_options_error(
            &data,
            &file_url(&alias),
            NSURLBookmarkFileCreationOptions::default(),
        )
        .unwrap();

        assert!(is_finder_alias(&alias).unwrap());
        assert_eq!(
            fs::canonicalize(resolve_finder_alias(&alias).unwrap()).unwrap(),
            fs::canonicalize(&target).unwrap()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reports_broken_foundation_alias_without_reading_bookmark_bytes() {
        let root = std::env::temp_dir().join(format!("vesperwind-broken-alias-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("removed.mkv");
        let alias = root.join("Broken alias.mkv");
        fs::write(&target, b"real media bytes").unwrap();

        let target_url = file_url(&target);
        let data = target_url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                NSURLBookmarkCreationOptions::SuitableForBookmarkFile,
                None,
                None,
            )
            .unwrap();
        NSURL::writeBookmarkData_toURL_options_error(
            &data,
            &file_url(&alias),
            NSURLBookmarkFileCreationOptions::default(),
        )
        .unwrap();
        fs::remove_file(&target).unwrap();

        let error = resolve_finder_alias(&alias).unwrap_err();
        assert_eq!(error.code, "EALIAS_BROKEN");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_configured_real_finder_alias() {
        let Some(path) = std::env::var_os("VESPERWIND_FINDER_ALIAS_TEST_PATH") else {
            return;
        };
        let alias = PathBuf::from(path);
        assert!(
            is_finder_alias(&alias).unwrap(),
            "fixture is not a Finder Alias"
        );

        let target = resolve_finder_alias(&alias).unwrap();
        eprintln!("finder_alias={alias:?} resolved_target={target:?}");
        assert_ne!(target, alias);
        assert!(fs::metadata(&target).unwrap().is_file());
        assert!(fs::metadata(&target).unwrap().len() > fs::metadata(&alias).unwrap().len());
    }
}
