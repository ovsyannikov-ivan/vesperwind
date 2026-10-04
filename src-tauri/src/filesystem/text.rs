use crate::error::NativeError;
use std::io::Read;

pub const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;

pub fn read_limit(requested: Option<u64>) -> u64 {
    requested.unwrap_or(MAX_TEXT_BYTES).min(MAX_TEXT_BYTES)
}

pub fn read_bounded(reader: impl Read, limit: u64, strict: bool) -> Result<String, NativeError> {
    let mut bytes = Vec::new();
    reader
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| NativeError::from_io(&error, "Unable to read text"))?;
    if bytes.len() as u64 > limit {
        return Err(NativeError::new(
            "EFILE_TOO_LARGE",
            "Text file exceeds the read limit",
        ));
    }
    if !strict {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    let invalid = || {
        NativeError::new(
            "ETEXT_BINARY",
            "This file does not contain supported UTF-8 text.",
        )
    };
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    if text
        .chars()
        .any(|ch| ch <= '\u{1f}' && !matches!(ch, '\t' | '\n' | '\r'))
    {
        return Err(invalid());
    }
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_preview_checks_actual_bytes_and_binary_data() {
        assert_eq!(read_bounded(&b"a\n\tb"[..], 4, true).unwrap(), "a\n\tb");
        assert_eq!(
            read_bounded(&b"abcde"[..], 4, true).unwrap_err().code,
            "EFILE_TOO_LARGE"
        );
        assert_eq!(
            read_bounded(&b"a\0b"[..], 4, true).unwrap_err().code,
            "ETEXT_BINARY"
        );
        assert_eq!(
            read_bounded(&[0xff][..], 4, true).unwrap_err().code,
            "ETEXT_BINARY"
        );
        assert_eq!(read_limit(Some(u64::MAX)), MAX_TEXT_BYTES);
    }
}
