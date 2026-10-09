This is the crates.io suppaftp 12.1.1 source, under its original
MIT OR Apache-2.0 license (LICENSE-MIT, LICENSE-APACHE from upstream).
Upstream: https://github.com/veeso/suppaftp

Vesperwind keeps one localized change: the control connection's trace log
(`CC OUT: ...` in src/sync_ftp/control.rs and the async variants) goes
through `command::loggable`, which replaces a `PASS` argument with `****`.
Upstream logs every outgoing command verbatim, including the password, when a
logger is enabled at trace level. The application builds today with
`log/max_level_off` (through ssh2-config's `nolog` feature), but the password
must stay out of logs even if that changes.

`command::tests::loggable_commands_never_contain_a_password` covers the patch.
Remove this copy when an upstream release redacts PASS in its logs.
