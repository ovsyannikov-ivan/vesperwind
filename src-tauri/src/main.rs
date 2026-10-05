#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

fn main() {
    if vesperwind_lib::run_filesystem_helper() {
        return;
    }
    vesperwind_lib::run();
}
