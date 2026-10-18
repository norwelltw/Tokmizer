use std::env;
use std::ffi::OsString;
use std::io::IsTerminal;

#[cfg(any(unix, windows))]
mod common;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[cfg(any(unix, windows))]
fn fallback(args: &[OsString]) -> i32 {
    #[cfg(unix)]
    let mut failure = None;
    for mut command in
        common::launch_candidates("TOKMIZER_EXEC_JS", "bin/tkr-exec.js", &["exec"], &[], false)
    {
        command.args(args);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            failure = Some(command.exec());
        }
        #[cfg(windows)]
        if let Ok(status) = command.status() {
            return status.code().unwrap_or(127);
        }
    }
    #[cfg(unix)]
    if let Some(error) = failure {
        eprintln!("tkr-exec: {error}");
    }
    127
}

#[cfg(not(any(unix, windows)))]
fn fallback(_: &[OsString]) -> i32 {
    127
}

#[cfg(any(unix, windows))]
fn passthrough(args: &[OsString]) -> i32 {
    let mut command = std::process::Command::new(&args[0]);
    command.args(&args[1..]);
    #[cfg(unix)]
    let error = {
        use std::os::unix::process::CommandExt;
        command.exec()
    };
    #[cfg(windows)]
    let error = match command.status() {
        Ok(status) => return status.code().unwrap_or(127),
        Err(error) => error,
    };
    eprintln!("tkr-exec: {error}");
    127
}

fn main() {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "--native-check" {
        println!("tokmizer-native {} protocol=2", env!("CARGO_PKG_VERSION"));
        return;
    }
    #[cfg(any(unix, windows))]
    if args.len() == 1 && args[0] == "--pre-tool-use" {
        std::process::exit(common::non_blocking(common::hook()));
    }
    #[cfg(any(unix, windows))]
    if args.len() == 1 && args[0] == "--session-start" {
        std::process::exit(common::session_start());
    }
    #[cfg(any(unix, windows))]
    if args.len() == 1 && args[0] == "--post-tool-use" {
        std::process::exit(common::non_blocking(common::post_hook()));
    }
    if args.is_empty() {
        if std::io::stdin().is_terminal() {
            eprintln!("tkr-exec: missing command");
            std::process::exit(2);
        }
        #[cfg(any(unix, windows))]
        std::process::exit(common::non_blocking(common::untagged_hook()));
        #[cfg(not(any(unix, windows)))]
        std::process::exit(0);
    }
    #[cfg(any(unix, windows))]
    if env::var_os(common::CAPTURING_ENV).is_some_and(|value| value == "1") {
        std::process::exit(passthrough(&args));
    }
    #[cfg(any(unix, windows))]
    if let Some(code) = common::run(&args) {
        std::process::exit(code);
    }
    std::process::exit(fallback(&args));
}
