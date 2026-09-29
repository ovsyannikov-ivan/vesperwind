import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  const perl = spawnSync('perl', ['-v'], {
    stdio: 'ignore',
    shell: false,
  })

  if (perl.error || perl.status !== 0) {
    console.error(`
Vesperwind Windows native builds require Strawberry Perl.

It is needed to build the vendored OpenSSL used by SSH/SFTP.

Install it with:

    winget install -e --id StrawberryPerl.StrawberryPerl

Then restart your terminal and verify:

    perl -v
    where.exe perl

See docs/build-windows.md for the other Windows build prerequisites.
`)
    process.exit(1)
  }
}
