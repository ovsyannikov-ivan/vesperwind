This is the crates.io suppaftp 12.1.1 source, under its original
MIT OR Apache-2.0 license (LICENSE-MIT, LICENSE-APACHE from upstream).
Upstream: https://github.com/veeso/suppaftp

Vesperwind keeps two localized changes:

- The control connection's trace log (`CC OUT: ...` in
  src/sync_ftp/control.rs and the async variants) goes through
  `command::loggable`, which replaces a `PASS` argument with `****`. Upstream
  logs every outgoing command verbatim, including the password, when a logger
  is enabled at trace level. The application builds today with
  `log/max_level_off` (through ssh2-config's `nolog` feature), but the password
  must stay out of logs even if that changes.
  `command::tests::loggable_commands_never_contain_a_password` covers it.
- `ImplFtpStream::connect_secure_implicit_with_stream` (src/sync_ftp.rs)
  accepts a caller-configured TCP stream for implicit FTPS, like the existing
  `connect_with_stream` for plain connections, so connect and socket timeouts
  also bound the TLS handshake and the greeting.
Remove this copy when an upstream release redacts PASS in its logs.
