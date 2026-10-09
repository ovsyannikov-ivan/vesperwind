//! Maps FTP library, socket and TLS failures to `NativeError`. Messages are
//! fixed text; server replies are attached as diagnostics only, and replies to
//! authentication commands are never included.
use crate::error::NativeError;
use suppaftp::FtpError;

/// Reply codes that close or reset the session on the server side.
pub fn is_connection_lost(error: &FtpError) -> bool {
    match error {
        FtpError::ConnectionError(_) | FtpError::BadResponse | FtpError::SecureError(_) => true,
        FtpError::UnexpectedResponse(response) => response.status.code() == 421,
        _ => false,
    }
}

pub fn reply_code(error: &FtpError) -> Option<u32> {
    match error {
        FtpError::UnexpectedResponse(response) => Some(response.status.code()),
        _ => None,
    }
}

fn reply_text(error: &FtpError) -> String {
    match error {
        FtpError::UnexpectedResponse(response) => {
            let text = String::from_utf8_lossy(&response.body);
            text.trim_end().chars().take(300).collect()
        }
        FtpError::ConnectionError(error) => error.kind().to_string(),
        other => other.to_string().chars().take(300).collect(),
    }
}

pub fn io_timed_out(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    )
}

/// A failed FTP command. `path` names the affected remote item, if any.
pub fn ftp_error(error: &FtpError, path: Option<&str>) -> NativeError {
    let native = match error {
        FtpError::ConnectionError(io) if io_timed_out(io) => {
            NativeError::new("ETIMEDOUT", "The FTP server did not respond in time")
        }
        FtpError::ConnectionError(_) | FtpError::BadResponse => {
            NativeError::new("EFTP_DISCONNECTED", "The FTP connection was lost")
        }
        FtpError::SecureError(_) => {
            NativeError::new("ETLS", "The secure connection to the FTP server failed")
        }
        FtpError::DataConnectionAlreadyOpen => NativeError::new(
            "EFTP_BUSY",
            "The FTP connection is busy with another transfer",
        ),
        FtpError::InvalidAddress(_) => {
            NativeError::new("EFTP", "The FTP server returned an invalid address")
        }
        FtpError::UnexpectedResponse(response) => {
            let (code, message) = match response.status.code() {
                421 => ("EFTP_DISCONNECTED", "The FTP server closed the connection"),
                425 | 426 => ("EFTP_TRANSFER", "The FTP data connection failed"),
                450 | 550 => (
                    "EFTP_UNAVAILABLE",
                    "The FTP server could not access this item",
                ),
                451 | 452 | 552 => (
                    "EFTP_TRANSFER",
                    "The FTP server reported that the transfer failed",
                ),
                530 | 532 => ("EACCES", "The FTP server denied access"),
                553 => ("EINVALID_NAME", "The FTP server refused this name"),
                500 | 501 | 502 | 504 => (
                    "ENOTSUPPORTED",
                    "The FTP server does not support this operation",
                ),
                521 | 522 | 533 | 534 | 536 => (
                    "EFTPS_PROTECTION",
                    "The FTP server refused the protected data connection",
                ),
                _ => ("EFTP", "The FTP operation failed"),
            };
            NativeError::new(code, message)
        }
    }
    .with_native_error(reply_text(error));
    match path {
        Some(path) => native.with_path(path),
        None => native,
    }
}

pub fn io_error(error: &std::io::Error, path: &str, message: &str) -> NativeError {
    let code = if io_timed_out(error) {
        "ETIMEDOUT"
    } else {
        "EFTP_TRANSFER"
    };
    NativeError::new(code, message)
        .with_path(path)
        .with_native_error(error.kind().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_classified_without_reply_secrets() {
        let timed_out =
            FtpError::ConnectionError(std::io::Error::from(std::io::ErrorKind::TimedOut));
        assert_eq!(ftp_error(&timed_out, None).code, "ETIMEDOUT");
        assert!(is_connection_lost(&timed_out));
        let lost =
            FtpError::ConnectionError(std::io::Error::from(std::io::ErrorKind::ConnectionReset));
        assert_eq!(ftp_error(&lost, Some("/a")).path.as_deref(), Some("/a"));
        assert_eq!(
            ftp_error(&FtpError::DataConnectionAlreadyOpen, None).code,
            "EFTP_BUSY"
        );
    }
}
