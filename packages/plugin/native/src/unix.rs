use crate::common::{
    invalid, launch_candidates, native_environment_supported, processor_descriptor_name, remaining,
    Capture, Channel, Descriptor, SPAWN_FRESH,
};
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::mem;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

pub type Stream = UnixStream;

static SIGNAL: AtomicI32 = AtomicI32::new(0);

fn private_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(invalid());
    }
    Ok(())
}

fn descriptor_named(home: &Path, name: &str) -> io::Result<Descriptor> {
    let directory = home.join("run");
    private_directory(&directory)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join(name))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 4096
    {
        return Err(invalid());
    }
    let value: Descriptor = serde_json::from_reader(file.take(4097)).map_err(|_| invalid())?;
    if !value.authentic() || value.home != home {
        return Err(invalid());
    }
    private_directory(value.path.parent().ok_or_else(invalid)?)?;
    let socket = fs::symlink_metadata(&value.path)?;
    if !socket.file_type().is_socket()
        || socket.uid() != unsafe { libc::getuid() }
        || socket.mode() & 0o077 != 0
    {
        return Err(invalid());
    }
    Ok(value)
}

pub fn endpoint(home: &Path) -> Option<(Descriptor, Stream)> {
    for name in [processor_descriptor_name(), "processing.json".to_owned()] {
        if let Ok(descriptor) = descriptor_named(home, &name) {
            if let Ok(stream) = connect(&descriptor.path) {
                return Some((descriptor, stream));
            }
        }
    }
    None
}

pub fn home() -> Option<PathBuf> {
    let home = env::var_os("TOKMIZER_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".tokmizer")))?;
    if !home.is_absolute() {
        return None;
    }
    Some(home)
}

pub fn canonical(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

pub fn spawn_processor(home: &Path) -> bool {
    if !native_environment_supported() {
        return false;
    }
    let run = home.join("run");
    if fs::symlink_metadata(&run).is_err() {
        use std::os::unix::fs::DirBuilderExt;
        let _ = fs::DirBuilder::new().mode(0o700).create(&run);
    }
    if private_directory(&run).is_err() {
        return false;
    }
    let commands = launch_candidates(
        "TOKMIZER_PROCESSOR_JS",
        "bin/tkr-processor.js",
        &["processor"],
        &["--max-semi-space-size=1"],
        true,
    );
    if commands.is_empty() {
        return false;
    }
    let marker = home
        .join("run")
        .join(format!("processor-{}.spawn", env!("CARGO_PKG_VERSION")));
    if let Some(age) = fs::symlink_metadata(&marker)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.elapsed().ok())
        .filter(|age| *age < Duration::from_secs(10))
    {
        return age < SPAWN_FRESH;
    }
    let touched = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&marker);
    if touched.is_err() {
        return false;
    }
    use std::os::unix::process::CommandExt;
    commands.into_iter().any(|mut command| {
        command
            .env("TOKMIZER_HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .is_ok()
    })
}

pub fn create_home(home: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    let _ = fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(home);
}

fn connect(path: &Path) -> io::Result<UnixStream> {
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    let bytes = path.as_os_str().as_bytes();
    if bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(invalid());
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe { libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = UnixStream::from(fd);
    stream.set_nonblocking(true)?;
    let result = unsafe {
        libc::connect(
            raw,
            &address as *const _ as *const libc::sockaddr,
            mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINPROGRESS) | Some(libc::EAGAIN)
        ) {
            return Err(error);
        }
        let mut poll = libc::pollfd {
            fd: raw,
            events: libc::POLLOUT,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 250) } <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "processing connect timeout",
            ));
        }
        let mut status: libc::c_int = 0;
        let mut size = mem::size_of_val(&status) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                raw,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                &mut status as *mut _ as *mut _,
                &mut size,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
    }
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_millis(250)))?;
    stream.set_write_timeout(Some(Duration::from_millis(250)))?;
    Ok(stream)
}

fn write_until(stream: &mut UnixStream, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        match stream.write(bytes) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "processing connection closed",
                ))
            }
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn read_until(stream: &mut UnixStream, mut bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
    while !bytes.is_empty() {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        match stream.read(bytes) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "processing connection closed",
                ))
            }
            Ok(count) => bytes = &mut bytes[count..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

impl Channel for UnixStream {
    fn write_until(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
        write_until(self, bytes, deadline)
    }

    fn read_until(&mut self, bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
        read_until(self, bytes, deadline)
    }
}

extern "C" fn signal_received(signal: libc::c_int) {
    SIGNAL.store(signal, Ordering::SeqCst);
}

struct Signals(Vec<(libc::c_int, libc::sigaction)>);

impl Signals {
    fn install() -> io::Result<Self> {
        let mut handlers = Self(Vec::new());
        for signal in [libc::SIGINT, libc::SIGTERM] {
            let mut action: libc::sigaction = unsafe { mem::zeroed() };
            let mut previous = unsafe { mem::zeroed() };
            action.sa_sigaction = signal_received as *const () as usize;
            unsafe {
                libc::sigemptyset(&mut action.sa_mask);
            }
            if unsafe { libc::sigaction(signal, &action, &mut previous) } < 0 {
                return Err(io::Error::last_os_error());
            }
            handlers.0.push((signal, previous));
        }
        Ok(handlers)
    }
}

impl Drop for Signals {
    fn drop(&mut self) {
        for (signal, previous) in &self.0 {
            unsafe {
                libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
    }
}

pub fn capture(
    args: &[OsString],
    home: &Path,
    timeout: u64,
) -> io::Result<(Capture, Capture, i32)> {
    let _signals = Signals::install()?;
    let path = env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .filter(|entry| !entry.as_os_str().is_empty() && entry != &home.join("shims"))
        .collect::<Vec<_>>();
    let mut child = Command::new(&args[0])
        .args(&args[1..])
        .env("PATH", env::join_paths(path).map_err(|_| invalid())?)
        .env(crate::common::CAPTURING_ENV, "1")
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut polls = [
        libc::pollfd {
            fd: stdout.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: stderr.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    for poll in &polls {
        let flags = unsafe { libc::fcntl(poll.fd, libc::F_GETFL) };
        if flags >= 0 {
            unsafe {
                libc::fcntl(poll.fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }
    }
    let mut captures = [Capture::new(), Capture::new()];
    let start = Instant::now();
    let mut terminated = None;
    let mut status = None;
    while status.is_none() || polls.iter().any(|poll| poll.fd >= 0) {
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(_) => {
                    let _ = child.kill();
                    status = child.wait().ok();
                }
            }
        }
        let signal = SIGNAL.swap(0, Ordering::SeqCst);
        if signal != 0 && status.is_none() {
            unsafe {
                libc::kill(child.id() as libc::pid_t, signal);
            }
        }
        if start.elapsed() >= Duration::from_millis(timeout) && terminated.is_none() {
            if status.is_none() {
                unsafe {
                    libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
                }
            }
            terminated = Some(Instant::now());
        }
        if terminated.is_some_and(|time| time.elapsed() >= Duration::from_secs(2)) {
            if status.is_none() {
                let _ = child.kill();
                status = child.wait().ok();
            }
            for (poll, capture) in polls.iter_mut().zip(&mut captures) {
                if poll.fd >= 0 {
                    capture.truncated = true;
                    poll.fd = -1;
                }
            }
            break;
        }
        let streams_closed = polls.iter().all(|poll| poll.fd < 0);
        if streams_closed && status.is_some() {
            break;
        }
        let result =
            unsafe { libc::poll(polls.as_mut_ptr(), 2, if streams_closed { 1 } else { 10 }) };
        if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            for (poll, capture) in polls.iter_mut().zip(&mut captures) {
                capture.truncated = true;
                poll.fd = -1;
            }
        }
        for (poll, capture) in polls.iter_mut().zip(&mut captures) {
            if poll.fd < 0 || poll.revents == 0 {
                continue;
            }
            let mut buffer = [0u8; 65536];
            let count = unsafe { libc::read(poll.fd, buffer.as_mut_ptr() as *mut _, buffer.len()) };
            if count > 0 {
                capture.append(&buffer[..count as usize]);
            } else if count == 0 {
                poll.fd = -1;
            } else if !matches!(
                io::Error::last_os_error().kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
            ) {
                capture.truncated = true;
                poll.fd = -1;
            }
        }
    }
    let [stdout, stderr] = captures;
    let code = status
        .map(|status| {
            status
                .code()
                .unwrap_or_else(|| 128 + status.signal().unwrap_or(15))
        })
        .unwrap_or(1);
    Ok((stdout, stderr, code))
}

pub fn script_fallback(variable: &str, relative: &str, words: &[&str], input: Vec<u8>) -> i32 {
    let _signals = Signals::install().ok();
    let child = launch_candidates(variable, relative, words, &[], false)
        .into_iter()
        .find_map(|mut command| {
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .ok()
        });
    let Some(mut child) = child else { return 0 };
    if let Some(mut sink) = child.stdin.take() {
        std::thread::spawn(move || {
            let mut source = io::Cursor::new(input).chain(io::stdin());
            let _ = io::copy(&mut source, &mut sink);
        });
    }
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return status
                    .code()
                    .unwrap_or_else(|| 128 + status.signal().unwrap_or(15))
            }
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return 0;
            }
        }
        let signal = SIGNAL.swap(0, Ordering::SeqCst);
        if signal != 0 {
            unsafe {
                libc::kill(child.id() as libc::pid_t, signal);
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_reads_share_one_deadline() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let sending = std::thread::spawn(move || {
            for _ in 0..20 {
                if writer.write_all(&[1]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let started = Instant::now();
        let result = read_until(
            &mut reader,
            &mut [0; 20],
            started + Duration::from_millis(25),
        );
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_millis(100));
        drop(reader);
        sending.join().unwrap();
    }
}
