This is the crates.io ssh2-config 0.8.1 source, under its original MIT license.
Upstream: https://github.com/veeso/ssh2-config

Vesperwind keeps three localized changes in src/parser.rs:

- Preserve the first occurrence of HostName, User, Port, IdentitiesOnly,
  ProxyCommand, ProxyJump, LocalCommand and IdentityAgent in one Host block.
  IdentityFile accumulation and library query/include semantics stay intact.
- Use Path::is_absolute for Include, recognizing Windows drive and UNC paths.
- Limit Include recursion to 16 levels, so a cyclic config returns an error
  rather than overflowing the application stack.

The application's ssh_config tests cover the singleton, include and cycle
behavior. No separate parser or OpenSSH subprocess is used.

Remove this patch when a maintained upstream release covers these cases.
