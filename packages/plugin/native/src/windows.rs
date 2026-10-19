use crate::common::{
    invalid, launch_candidates, native_environment_supported, post_exit_released,
    processor_descriptor_name, remaining, Capture, Channel, Descriptor, SPAWN_FRESH,
};
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{
    LocalFree, SetHandleInformation, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_PIPE_BUSY,
    ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    GetSecurityInfo, SE_FILE_OBJECT, SE_KERNEL_OBJECT, SE_OBJECT_TYPE,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TokenOwner, TokenUser, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, TOKEN_INFORMATION_CLASS, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, SetConsoleCtrlHandler, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject,
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

const PIPE_PREFIX: &str = r"\\.\pipe\tokmizer-";
const TIMED_OUT_CODE: i32 = 143;

pub struct Stream {
    pipe: OwnedHandle,
    event: OwnedHandle,
}

impl Stream {
    fn transfer(
        &mut self,
        pointer: *mut u8,
        length: usize,
        deadline: Instant,
        write: bool,
    ) -> io::Result<usize> {
        let wait = remaining(deadline)?;
        let handle = self.pipe.as_raw_handle() as HANDLE;
        let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
        overlapped.hEvent = self.event.as_raw_handle() as HANDLE;
        let length = length.min(u32::MAX as usize) as u32;
        let mut count = 0u32;
        let started = unsafe {
            if write {
                WriteFile(handle, pointer, length, ptr::null_mut(), &mut overlapped)
            } else {
                ReadFile(handle, pointer, length, ptr::null_mut(), &mut overlapped)
            }
        };
        if started == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(0);
            }
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
        }
        let millis = wait.as_millis().clamp(1, u128::from(u32::MAX - 1)) as u32;
        if unsafe { WaitForSingleObject(overlapped.hEvent, millis) } != WAIT_OBJECT_0 {
            unsafe {
                CancelIoEx(handle, &overlapped);
                GetOverlappedResult(handle, &overlapped, &mut count, 1);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "processing deadline exceeded",
            ));
        }
        if unsafe { GetOverlappedResult(handle, &overlapped, &mut count, 0) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(0);
            }
            return Err(error);
        }
        Ok(count as usize)
    }
}

impl Channel for Stream {
    fn write_until(&mut self, mut bytes: &[u8], deadline: Instant) -> io::Result<()> {
        while !bytes.is_empty() {
            match self.transfer(bytes.as_ptr() as *mut u8, bytes.len(), deadline, true)? {
                0 => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "processing connection closed",
                    ))
                }
                count => bytes = &bytes[count..],
            }
        }
        Ok(())
    }

    fn read_until(&mut self, mut bytes: &mut [u8], deadline: Instant) -> io::Result<()> {
        while !bytes.is_empty() {
            match self.transfer(bytes.as_mut_ptr(), bytes.len(), deadline, false)? {
                0 => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "processing connection closed",
                    ))
                }
                count => bytes = &mut bytes[count..],
            }
        }
        Ok(())
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn token_information(class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<u64>> {
    let mut token: HANDLE = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
    let mut size = 0u32;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            class,
            ptr::null_mut(),
            0,
            &mut size,
        );
    }
    let mut buffer = vec![0u64; (size as usize).div_ceil(8).max(1)];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            class,
            buffer.as_mut_ptr() as *mut _,
            (buffer.len() * 8) as u32,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

fn owned_by_current_user(handle: HANDLE, kind: SE_OBJECT_TYPE) -> io::Result<()> {
    let user = token_information(TokenUser)?;
    let owner = token_information(TokenOwner)?;
    let mut sid: PSID = ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle,
            kind,
            OWNER_SECURITY_INFORMATION,
            &mut sid,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(status as i32));
    }
    let trusted = !sid.is_null()
        && unsafe {
            let user = (*(user.as_ptr() as *const TOKEN_USER)).User.Sid;
            let owner = (*(owner.as_ptr() as *const TOKEN_OWNER)).Owner;
            EqualSid(sid, user) != 0 || EqualSid(sid, owner) != 0
        };
    unsafe {
        LocalFree(descriptor as _);
    }
    if trusted {
        Ok(())
    } else {
        Err(invalid())
    }
}

fn open_entry(path: &Path, directory: bool) -> io::Result<File> {
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)?;
    let metadata = file.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.is_dir() != directory
    {
        return Err(invalid());
    }
    owned_by_current_user(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT)?;
    Ok(file)
}

fn private_directory(path: &Path) -> io::Result<()> {
    open_entry(path, true).map(|_| ())
}

fn path_matches(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

fn pipe_name(path: &Path) -> Option<&str> {
    let name = path.to_str()?;
    let suffix = name.strip_prefix(PIPE_PREFIX)?;
    (!suffix.is_empty()
        && suffix.len() <= 200
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')))
    .then_some(name)
}

fn descriptor_named(home: &Path, name: &str) -> io::Result<Descriptor> {
    let directory = home.join("run");
    private_directory(&directory)?;
    let file = open_entry(&directory.join(name), false)?;
    if file.metadata()?.len() > 4096 {
        return Err(invalid());
    }
    let value: Descriptor = serde_json::from_reader(file.take(4097)).map_err(|_| invalid())?;
    if !value.authentic() || !path_matches(&value.home, home) || pipe_name(&value.path).is_none() {
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
        .or_else(|| {
            env::var_os("USERPROFILE")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".tokmizer"))
        })?;
    if !home.is_absolute() {
        return None;
    }
    Some(home)
}

pub fn create_home(home: &Path) {
    let _ = fs::create_dir_all(home);
}

pub fn canonical(path: &Path) -> Option<PathBuf> {
    let resolved = fs::canonicalize(path).ok()?;
    let text = resolved.to_str()?;
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return Some(PathBuf::from(format!(r"\\{rest}")));
    }
    Some(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(text)))
}

fn connect(path: &Path) -> io::Result<Stream> {
    let name = wide(OsStr::new(pipe_name(path).ok_or_else(invalid)?));
    let deadline = Instant::now() + Duration::from_millis(250);
    let handle = loop {
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            break unsafe { OwnedHandle::from_raw_handle(handle as _) };
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32) {
            return Err(error);
        }
        let wait = remaining(deadline)?.as_millis().clamp(1, 250) as u32;
        unsafe {
            WaitNamedPipeW(name.as_ptr(), wait);
        }
    };
    owned_by_current_user(handle.as_raw_handle() as HANDLE, SE_KERNEL_OBJECT)?;
    let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(Stream {
        pipe: handle,
        event: unsafe { OwnedHandle::from_raw_handle(event as _) },
    })
}

fn detach_standard_handles() {
    for kind in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        unsafe {
            let handle = GetStdHandle(kind);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

pub fn spawn_processor(home: &Path) -> bool {
    if !native_environment_supported() {
        return false;
    }
    let run = home.join("run");
    if fs::symlink_metadata(&run).is_err() {
        let _ = fs::create_dir(&run);
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
    let marker = run.join(format!("processor-{}.spawn", env!("CARGO_PKG_VERSION")));
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
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&marker);
    if touched.is_err() {
        return false;
    }
    detach_standard_handles();
    let flags = CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    commands.into_iter().any(|mut command| {
        command
            .env("TOKMIZER_HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB)
            .spawn()
            .is_ok()
            || command.creation_flags(flags).spawn().is_ok()
    })
}

unsafe extern "system" fn ignore_interrupt(_: u32) -> BOOL {
    1
}

struct Interrupts;

impl Interrupts {
    fn install() -> Self {
        unsafe {
            SetConsoleCtrlHandler(Some(ignore_interrupt), 1);
        }
        Self
    }
}

impl Drop for Interrupts {
    fn drop(&mut self) {
        unsafe {
            SetConsoleCtrlHandler(Some(ignore_interrupt), 0);
        }
    }
}

fn drain(
    mut source: impl Read + Send + 'static,
    finished: mpsc::Sender<()>,
) -> Arc<Mutex<Capture>> {
    let capture = Arc::new(Mutex::new(Capture::new()));
    let shared = Arc::clone(&capture);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 65536];
        loop {
            match source.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => shared.lock().unwrap().append(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    if error.raw_os_error() != Some(ERROR_BROKEN_PIPE as i32) {
                        shared.lock().unwrap().truncated = true;
                    }
                    break;
                }
            }
        }
        let _ = finished.send(());
    });
    capture
}

fn take(capture: &Arc<Mutex<Capture>>, incomplete: bool) -> Capture {
    let mut guard = capture.lock().unwrap();
    let mut value = mem::replace(&mut *guard, Capture::new());
    value.truncated |= incomplete;
    value
}

fn wait_streams(receiver: &mpsc::Receiver<()>, finished: &mut usize, until: Instant) {
    while *finished < 2 {
        let Some(wait) = until.checked_duration_since(Instant::now()) else {
            return;
        };
        match receiver.recv_timeout(wait) {
            Ok(()) => *finished += 1,
            Err(_) => return,
        }
    }
}

pub fn capture(
    args: &[OsString],
    home: &Path,
    timeout: u64,
) -> io::Result<(Capture, Capture, i32)> {
    let _interrupts = Interrupts::install();
    let shims = home.join("shims");
    let path = env::split_paths(&env::var_os("PATH").unwrap_or_default())
        .filter(|entry| !entry.as_os_str().is_empty() && !path_matches(entry, &shims))
        .collect::<Vec<_>>();
    let mut child = Command::new(&args[0])
        .args(&args[1..])
        .env("PATH", env::join_paths(path).map_err(|_| invalid())?)
        .env(crate::common::CAPTURING_ENV, "1")
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (sender, receiver) = mpsc::channel();
    let stdout = drain(child.stdout.take().unwrap(), sender.clone());
    let stderr = drain(child.stderr.take().unwrap(), sender);
    let deadline = Instant::now() + Duration::from_millis(timeout);
    let mut finished = 0;
    let mut status = None;
    let mut exited: Option<Instant> = None;
    let mut last_data = Instant::now();
    let mut seen = 0usize;
    let mut released = false;
    while finished < 2 {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        wait_streams(
            &receiver,
            &mut finished,
            deadline.min(now + Duration::from_millis(10)),
        );
        if finished == 2 {
            break;
        }
        let now = Instant::now();
        if status.is_none() {
            if let Ok(Some(value)) = child.try_wait() {
                status = Some(value);
                exited = Some(now);
            }
        }
        let total = stdout.lock().unwrap().bytes.len() + stderr.lock().unwrap().bytes.len();
        if total != seen {
            seen = total;
            last_data = now;
        }
        if exited.is_some_and(|time| post_exit_released(time, last_data, now)) {
            // A background descendant keeps the pipes open: deliver what was
            // read without waiting for (or killing) it.
            released = true;
            break;
        }
    }
    if finished == 2 && status.is_none() {
        let wait = deadline
            .checked_duration_since(Instant::now())
            .map_or(0, |value| {
                value.as_millis().clamp(1, u128::from(u32::MAX - 1)) as u32
            });
        if unsafe { WaitForSingleObject(child.as_raw_handle() as HANDLE, wait) } == WAIT_OBJECT_0 {
            status = child.wait().ok();
        }
    }
    let mut timed_out = false;
    if status.is_none() {
        timed_out = child.try_wait().ok().flatten().is_none();
        let _ = child.kill();
        status = child.wait().ok();
        wait_streams(
            &receiver,
            &mut finished,
            Instant::now() + Duration::from_secs(2),
        );
    }
    let incomplete = finished < 2 && !released;
    let code = if timed_out {
        TIMED_OUT_CODE
    } else {
        status.and_then(|status| status.code()).unwrap_or(1)
    };
    Ok((take(&stdout, incomplete), take(&stderr, incomplete), code))
}

pub fn script_fallback(variable: &str, relative: &str, words: &[&str], input: Vec<u8>) -> i32 {
    let _interrupts = Interrupts::install();
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
            let _ = sink.flush();
        });
    }
    match child.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_names_are_confined_to_the_tokmizer_namespace() {
        assert!(pipe_name(Path::new(r"\\.\pipe\tokmizer-p-alice-0.9.56-1a2b3c4d")).is_some());
        assert!(pipe_name(Path::new(r"\\.\pipe\tokmizer-")).is_none());
        assert!(pipe_name(Path::new(r"\\.\pipe\other")).is_none());
        assert!(pipe_name(Path::new(r"\\server\pipe\tokmizer-x")).is_none());
        assert!(pipe_name(Path::new(r"\\.\pipe\tokmizer-a\..\b")).is_none());
        assert!(pipe_name(Path::new(r"C:\tokmizer-x")).is_none());
    }

    #[test]
    fn verbatim_prefixes_are_removed_from_canonical_paths() {
        let directory = env::temp_dir();
        let resolved = canonical(&directory).unwrap();
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));
        assert!(path_matches(&resolved, &canonical(&resolved).unwrap()));
    }

    #[test]
    fn home_paths_compare_without_case() {
        assert!(path_matches(
            Path::new(r"C:\Users\Alice\.tokmizer"),
            Path::new(r"c:\users\alice\.TOKMIZER")
        ));
        assert!(!path_matches(
            Path::new(r"C:\Users\Alice\.tokmizer"),
            Path::new(r"C:\Users\Bob\.tokmizer")
        ));
    }
}
