#![windows_subsystem = "windows"]

use raw_window_handle::{HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::num::NonZeroIsize;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, CreateSolidBrush, HBRUSH};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_TCP_STATE_LISTEN,
    TCP_TABLE_OWNER_PID_LISTENER,
};
use windows_sys::Win32::Networking::WinSock::AF_INET;
use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows, GetClientRect,
    GetMessageW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, KillTimer,
    PostMessageW, PostQuitMessage, RegisterClassW, SetTimer, SetWindowPos, ShowWindow,
    TranslateMessage, HWND_TOP, MSG, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNA, WM_APP, WM_DESTROY,
    WM_TIMER, WNDCLASSW, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_TOOLWINDOW, WS_POPUP,
};
use wry::dpi::{PhysicalPosition, PhysicalSize};
use wry::{Rect, WebContext, WebView, WebViewBuilder};

const WM_RUN_CMD: u32 = WM_APP + 1;
const TIMER_WATCHDOG: usize = 1;
const TIMER_SYNC: usize = 2;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct BoundsReq {
    visible: bool,
    x: Option<f64>,
    y: Option<f64>,
    right_margin: Option<f64>,
    top_margin: Option<f64>,
    width: f64,
    height: f64,
    zoom: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
struct TabMeta {
    id: String,
    url: String,
    title: String,
}

#[derive(Clone, Debug, Serialize)]
struct StatusResp {
    ok: bool,
    pid: u32,
    active_tab: String,
    url: String,
    title: String,
    tabs: Vec<TabMeta>,
    visible: bool,
    herdr_hwnd: isize,
    dpi: u32,
    new_ports: Vec<u16>,
    active_ports: Vec<u16>,
}

#[derive(Debug)]
enum HostCmd {
    OpenTab {
        id: Option<String>,
        url: String,
        dedupe: bool,
    },
    SelectTab(String),
    CloseTab(String),
    Navigate {
        id: Option<String>,
        url: String,
    },
    Back,
    Forward,
    Reload,
    DevTools,
    Bounds(BoundsReq),
    Ping,
    Fullscreen(bool),
    Quit,
}

struct SharedState {
    tabs: Vec<TabMeta>,
    active_tab: String,
    visible: bool,
    herdr_hwnd: isize,
    new_ports: Vec<u16>,
    active_ports: Vec<u16>,
    queue: VecDeque<HostCmd>,
}

struct TabEntry {
    id: String,
    webview: WebView,
}

struct AppContext {
    state: Arc<Mutex<SharedState>>,
    container_hwnd: HWND,
    web_context: WebContext,
    tabs: Vec<TabEntry>,
    active_tab: String,
    next_tab_seq: u64,
    last_bounds: Option<BoundsReq>,
    last_applied_rect: Option<(i32, i32, i32, i32)>,
    last_visible_ping: Instant,
    currently_shown: bool,
    fullscreen: bool,
}

struct HwndWrapper(HWND);

impl HasWindowHandle for HwndWrapper {
    fn window_handle(&self) -> Result<WindowHandle<'_>, raw_window_handle::HandleError> {
        let nz = NonZeroIsize::new(self.0 as isize).unwrap();
        let handle = Win32WindowHandle::new(nz);
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(handle)) })
    }
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn find_herdr_pids() -> Vec<u32> {
    let mut pids = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == 0 as _ || snap == -1isize as _ {
            return pids;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                if name == "herdr-app.exe" {
                    pids.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        windows_sys::Win32::Foundation::CloseHandle(snap);
    }
    pids
}

struct EnumCtx {
    pids: Vec<u32>,
    found: HWND,
    best_area: i64,
}

unsafe extern "system" fn enum_windows_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let ctx = &mut *(lparam as *mut EnumCtx);
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if ctx.pids.contains(&pid) && IsWindowVisible(hwnd) != 0 {
        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect) != 0 {
            let area = (rect.right - rect.left) as i64 * (rect.bottom - rect.top) as i64;
            if area > ctx.best_area {
                ctx.best_area = area;
                ctx.found = hwnd;
            }
        }
    }
    1
}

fn find_herdr_hwnd() -> Option<HWND> {
    let pids = find_herdr_pids();
    if pids.is_empty() {
        return None;
    }
    let mut ctx = EnumCtx {
        pids,
        found: std::ptr::null_mut(),
        best_area: 0,
    };
    unsafe {
        EnumWindows(Some(enum_windows_cb), &mut ctx as *mut EnumCtx as LPARAM);
    }
    if ctx.found.is_null() {
        None
    } else {
        Some(ctx.found)
    }
}

/// Enumerate IPv4 TCP listening ports bound to 127.0.0.1 or 0.0.0.0.
fn list_local_listening_ports() -> HashSet<u16> {
    let mut ports = HashSet::new();
    unsafe {
        let mut size: u32 = 0;
        let _ = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if size == 0 {
            return ports;
        }
        let mut buf = vec![0u8; size as usize + 1024];
        let mut buf_size = buf.len() as u32;
        let ret = GetExtendedTcpTable(
            buf.as_mut_ptr() as *mut _,
            &mut buf_size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if ret != 0 {
            return ports;
        }
        let table = &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
        let count = table.dwNumEntries as usize;
        let rows_ptr = table.table.as_ptr();
        for i in 0..count {
            let row: &MIB_TCPROW_OWNER_PID = &*rows_ptr.add(i);
            if row.dwState != MIB_TCP_STATE_LISTEN as u32 {
                continue;
            }
            // 0.0.0.0 or 127.0.0.1 in network byte order
            let addr = row.dwLocalAddr;
            if addr != 0 && addr != 0x0100007F {
                continue;
            }
            let port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
            if port >= 1024 {
                ports.insert(port);
            }
        }
    }
    ports
}

fn probe_http_port(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(180)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
    if stream
        .write_all(b"HEAD / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 16];
    match stream.read(&mut buf) {
        Ok(n) if n >= 5 => buf[..n].starts_with(b"HTTP/"),
        _ => false,
    }
}

fn spawn_port_watcher(state: Arc<Mutex<SharedState>>, self_port: u16) {
    thread::spawn(move || {
        let mut baseline = list_local_listening_ports();
        baseline.insert(self_port);
        let mut probed: HashMap<u16, bool> = HashMap::new();

        loop {
            thread::sleep(Duration::from_millis(1800));
            let current = list_local_listening_ports();

            // Drop stale probe entries for ports that stopped listening so restarts get re-detected
            probed.retain(|p, _| current.contains(p));
            // Also remove stopped ports from baseline so if a previously running server restarts, it can be detected
            baseline.retain(|p| *p == self_port || current.contains(p));

            let mut new_http = Vec::new();
            let mut active_http = Vec::new();

            for &port in &current {
                if port == self_port {
                    continue;
                }
                let is_baseline = baseline.contains(&port);
                if is_baseline {
                    continue;
                }
                let is_http = *probed.entry(port).or_insert_with(|| probe_http_port(port));
                if is_http {
                    new_http.push(port);
                    active_http.push(port);
                }
            }

            new_http.sort_unstable();
            active_http.sort_unstable();

            if let Ok(mut st) = state.lock() {
                st.new_ports = new_http;
                st.active_ports = active_http;
            }
        }
    });
}

static mut APP_PTR: *mut AppContext = std::ptr::null_mut();

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_RUN_CMD => {
            if !APP_PTR.is_null() {
                let app = &mut *APP_PTR;
                process_commands(app);
            }
            0
        }
        WM_TIMER => {
            if !APP_PTR.is_null() {
                let app = &mut *APP_PTR;
                if wparam == TIMER_WATCHDOG {
                    let herdr = app.state.lock().unwrap().herdr_hwnd as HWND;
                    if !herdr.is_null() && IsWindow(herdr) == 0 {
                        DestroyWindow(hwnd);
                    }
                } else if wparam == TIMER_SYNC {
                    apply_bounds(app, false);
                }
            }
            0
        }
        WM_DESTROY => {
            KillTimer(hwnd, TIMER_WATCHDOG);
            KillTimer(hwnd, TIMER_SYNC);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn current_size(app: &AppContext) -> (u32, u32) {
    if let Some((_, _, pw, ph)) = app.last_applied_rect {
        (pw.max(1) as u32, ph.max(1) as u32)
    } else {
        (460, 720)
    }
}

fn create_tab(app: &mut AppContext, id_opt: Option<String>, url: &str) -> Option<String> {
    let tab_id = id_opt.unwrap_or_else(|| {
        app.next_tab_seq += 1;
        format!("tab-{}", app.next_tab_seq)
    });

    let (w, h) = current_size(app);
    let state_nav = Arc::clone(&app.state);
    let state_title = Arc::clone(&app.state);
    let id_nav = tab_id.clone();
    let id_title = tab_id.clone();

    let wrapper = HwndWrapper(app.container_hwnd);
    let wv_res = WebViewBuilder::with_web_context(&mut app.web_context)
        .with_url(url)
        .with_devtools(true)
        .with_bounds(Rect {
            position: PhysicalPosition::new(0, 0).into(),
            size: PhysicalSize::new(w, h).into(),
        })
        .with_navigation_handler(move |new_url| {
            if let Ok(mut st) = state_nav.lock() {
                if let Some(t) = st.tabs.iter_mut().find(|t| t.id == id_nav) {
                    t.url = new_url;
                }
            }
            true
        })
        .with_document_title_changed_handler(move |new_title| {
            if let Ok(mut st) = state_title.lock() {
                if let Some(t) = st.tabs.iter_mut().find(|t| t.id == id_title) {
                    t.title = new_title;
                }
            }
        })
        .build_as_child(&wrapper);

    match wv_res {
        Ok(wv) => {
            app.tabs.push(TabEntry {
                id: tab_id.clone(),
                webview: wv,
            });
            if let Ok(mut st) = app.state.lock() {
                st.tabs.push(TabMeta {
                    id: tab_id.clone(),
                    url: url.to_string(),
                    title: String::new(),
                });
            }
            Some(tab_id)
        }
        Err(_) => None,
    }
}

fn select_tab(app: &mut AppContext, id: &str) {
    if !app.tabs.iter().any(|t| t.id == id) {
        return;
    }
    app.active_tab = id.to_string();
    if let Ok(mut st) = app.state.lock() {
        st.active_tab = id.to_string();
    }
    let (w, h) = current_size(app);
    for tab in &app.tabs {
        if tab.id == app.active_tab {
            let _ = tab.webview.set_bounds(Rect {
                position: PhysicalPosition::new(0, 0).into(),
                size: PhysicalSize::new(w, h).into(),
            });
            let _ = tab.webview.set_visible(app.currently_shown);
        } else {
            let _ = tab.webview.set_visible(false);
        }
    }
}

fn close_tab(app: &mut AppContext, id: &str) {
    let idx = match app.tabs.iter().position(|t| t.id == id) {
        Some(i) => i,
        None => return,
    };
    app.tabs.remove(idx);
    if let Ok(mut st) = app.state.lock() {
        st.tabs.retain(|t| t.id != id);
    }

    if app.tabs.is_empty() {
        if let Some(new_id) = create_tab(app, None, "about:blank") {
            select_tab(app, &new_id);
        }
    } else if app.active_tab == id {
        let next_idx = idx.min(app.tabs.len() - 1);
        let next_id = app.tabs[next_idx].id.clone();
        select_tab(app, &next_id);
    }
}

fn active_webview(app: &AppContext) -> Option<&WebView> {
    app.tabs
        .iter()
        .find(|t| t.id == app.active_tab)
        .map(|t| &t.webview)
}

fn hide_container(app: &mut AppContext) {
    unsafe {
        if app.currently_shown {
            ShowWindow(app.container_hwnd, SW_HIDE);
            for tab in &app.tabs {
                let _ = tab.webview.set_visible(false);
            }
            app.currently_shown = false;
            app.last_applied_rect = None;
        }
    }
}

fn apply_bounds(app: &mut AppContext, force: bool) {
    let b = match &app.last_bounds {
        Some(b) => b.clone(),
        None => return,
    };
    let herdr = app.state.lock().unwrap().herdr_hwnd as HWND;
    unsafe {
        let herdr_hidden = herdr.is_null()
            || IsWindow(herdr) == 0
            || IsIconic(herdr) != 0
            || IsWindowVisible(herdr) == 0;

        let ping_expired = app.last_visible_ping.elapsed() > Duration::from_millis(650);

        if !b.visible || b.width < 10.0 || b.height < 10.0 || herdr_hidden || ping_expired {
            app.fullscreen = false;
            hide_container(app);
            app.state.lock().unwrap().visible = false;
            return;
        }

        let dpi = GetDpiForWindow(herdr);
        let dpi_scale = (dpi.max(96) as f64) / 96.0;
        let zoom = b.zoom.unwrap_or(1.0).clamp(0.5, 3.0);

        let mut client: RECT = std::mem::zeroed();
        GetClientRect(herdr, &mut client);
        let client_w = (client.right - client.left) as f64;
        let client_h = (client.bottom - client.top) as f64;

        let mut origin = POINT { x: 0, y: 0 };
        ClientToScreen(herdr, &mut origin);

        let (sx, sy, pw, ph) = if app.fullscreen {
            (
                origin.x,
                origin.y,
                client_w.round().max(100.0) as i32,
                client_h.round().max(100.0) as i32,
            )
        } else {
            let pw = (b.width * dpi_scale).round().max(1.0) as i32;
            let ph = (b.height * dpi_scale).round().max(1.0) as i32;

            let local_x = if let Some(x) = b.x {
                (x * dpi_scale).round() as i32
            } else if let Some(rm) = b.right_margin {
                (client_w - (rm * dpi_scale * zoom) - (pw as f64))
                    .round()
                    .max(0.0) as i32
            } else {
                (client_w - (pw as f64) - (9.0 * dpi_scale * zoom))
                    .round()
                    .max(0.0) as i32
            };

            let local_y = if let Some(y) = b.y {
                (y * dpi_scale).round() as i32
            } else if let Some(tm) = b.top_margin {
                (tm * dpi_scale * zoom).round() as i32
            } else {
                (119.0 * dpi_scale * zoom).round() as i32
            };

            (origin.x + local_x, origin.y + local_y, pw, ph)
        };
        let rect_key = (sx, sy, pw, ph);

        if !force && app.currently_shown && app.last_applied_rect == Some(rect_key) {
            return;
        }

        SetWindowPos(
            app.container_hwnd,
            HWND_TOP,
            sx,
            sy,
            pw,
            ph,
            SWP_NOACTIVATE,
        );
        if !app.currently_shown || force {
            ShowWindow(app.container_hwnd, SW_SHOWNA);
        }
        for tab in &app.tabs {
            if tab.id == app.active_tab {
                let _ = tab.webview.set_bounds(Rect {
                    position: PhysicalPosition::new(0, 0).into(),
                    size: PhysicalSize::new(pw as u32, ph as u32).into(),
                });
                let _ = tab.webview.set_visible(true);
            } else {
                let _ = tab.webview.set_visible(false);
            }
        }
        app.currently_shown = true;
        app.last_applied_rect = Some(rect_key);
        app.state.lock().unwrap().visible = true;
    }
}

fn process_commands(app: &mut AppContext) {
    let cmds: Vec<HostCmd> = {
        let mut st = app.state.lock().unwrap();
        st.queue.drain(..).collect()
    };
    for cmd in cmds {
        match cmd {
            HostCmd::OpenTab { id, url, dedupe } => {
                if dedupe {
                    let norm_target = url.trim_end_matches('/');
                    let existing_id = {
                        let st = app.state.lock().unwrap();
                        st.tabs
                            .iter()
                            .find(|t| t.url.trim_end_matches('/') == norm_target)
                            .map(|t| t.id.clone())
                    };
                    if let Some(eid) = existing_id {
                        select_tab(app, &eid);
                        continue;
                    }
                }
                // Reuse the active tab if it's currently about:blank
                let reuse_blank = {
                    let st = app.state.lock().unwrap();
                    st.tabs.len() == 1
                        && st.tabs[0].url == "about:blank"
                        && url != "about:blank"
                };
                if reuse_blank {
                    let tid = app.tabs[0].id.clone();
                    let _ = app.tabs[0].webview.load_url(&url);
                    if let Ok(mut st) = app.state.lock() {
                        if let Some(t) = st.tabs.iter_mut().find(|t| t.id == tid) {
                            t.url = url;
                        }
                    }
                    select_tab(app, &tid);
                } else if let Some(new_id) = create_tab(app, id, &url) {
                    select_tab(app, &new_id);
                }
            }
            HostCmd::SelectTab(id) => {
                if app.fullscreen {
                    app.fullscreen = false;
                    apply_bounds(app, true);
                }
                select_tab(app, &id);
            }
            HostCmd::CloseTab(id) => {
                if app.fullscreen {
                    app.fullscreen = false;
                    apply_bounds(app, true);
                }
                close_tab(app, &id);
            }
            HostCmd::Navigate { id, url } => {
                let target_id = id.unwrap_or_else(|| app.active_tab.clone());
                if let Some(tab) = app.tabs.iter().find(|t| t.id == target_id) {
                    let _ = tab.webview.load_url(&url);
                    if let Ok(mut st) = app.state.lock() {
                        if let Some(t) = st.tabs.iter_mut().find(|t| t.id == target_id) {
                            t.url = url;
                        }
                    }
                }
            }
            HostCmd::Back => {
                if let Some(wv) = active_webview(app) {
                    let _ = wv.evaluate_script("history.back()");
                }
            }
            HostCmd::Forward => {
                if let Some(wv) = active_webview(app) {
                    let _ = wv.evaluate_script("history.forward()");
                }
            }
            HostCmd::Reload => {
                if let Some(wv) = active_webview(app) {
                    let _ = wv.evaluate_script("location.reload()");
                }
            }
            HostCmd::DevTools => {
                if let Some(wv) = active_webview(app) {
                    if wv.is_devtools_open() {
                        wv.close_devtools();
                    } else {
                        wv.open_devtools();
                    }
                }
            }
            HostCmd::Bounds(b) => {
                if b.visible {
                    app.last_visible_ping = Instant::now();
                }
                app.last_bounds = Some(b);
                apply_bounds(app, true);
            }
            HostCmd::Ping => {
                app.last_visible_ping = Instant::now();
                if !app.currently_shown {
                    apply_bounds(app, true);
                }
            }
            HostCmd::Fullscreen(active) => {
                app.last_visible_ping = Instant::now();
                app.fullscreen = active;
                apply_bounds(app, true);
            }
            HostCmd::Quit => unsafe {
                DestroyWindow(app.container_hwnd);
            },
        }
    }
}

fn spawn_http_server(
    listener: TcpListener,
    state: Arc<Mutex<SharedState>>,
    container_hwnd: isize,
) {
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let state = Arc::clone(&state);
            thread::spawn(move || {
                handle_http(stream, state, container_hwnd);
            });
        }
    });
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_query(full_path: &str) -> (&str, HashMap<String, String>) {
    let mut map = HashMap::new();
    let (route, qs) = match full_path.split_once('?') {
        Some((r, q)) => (r, q),
        None => return (full_path, map),
    };
    for pair in qs.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            map.insert(percent_decode(k), percent_decode(v));
        }
    }
    (route, map)
}

fn render_artifact_html(file_path: &str, theme_hint: &str) -> (String, String) {
    let path_obj = PathBuf::from(file_path);
    let file_name = path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_path)
        .to_string();
    let ext = path_obj
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mode = match ext.as_str() {
        "md" | "mdx" | "markdown" => "markdown",
        "json" | "jsonc" => "json",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "svg" => "image",
        "docx" => "docx",
        "pptx" => "pptx",
        "xlsx" | "xls" => "excel",
        "csv" => "csv",
        _ => "text",
    };

    let base_dir = path_obj
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();

    let is_binary_viewer = matches!(mode, "image" | "docx" | "pptx" | "excel");
    let (content, err_msg) = if is_binary_viewer {
        if path_obj.exists() {
            (String::new(), None)
        } else {
            (String::new(), Some(format!("File not found: {}", file_path)))
        }
    } else {
        match std::fs::read(&path_obj) {
            Ok(bytes) => {
                if bytes.len() > 4 * 1024 * 1024 {
                    let slice = &bytes[..4 * 1024 * 1024];
                    (
                        String::from_utf8_lossy(slice).into_owned(),
                        Some("File truncated at 4 MiB for preview.".to_string()),
                    )
                } else if bytes.iter().take(4096).any(|&b| b == 0) {
                    (
                        String::new(),
                        Some("Binary file cannot be rendered as text.".to_string()),
                    )
                } else {
                    (String::from_utf8_lossy(&bytes).into_owned(), None)
                }
            }
            Err(e) => (String::new(), Some(format!("Cannot read file: {}", e))),
        }
    };

    let payload = serde_json::json!({
        "name": file_name,
        "path": file_path,
        "baseDir": base_dir,
        "ext": ext,
        "mode": mode,
        "theme": theme_hint,
        "content": content,
        "error": err_msg,
    })
    .to_string()
    .replace("</", "<\\/");

    let title_esc = file_name
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{title}</title>
<style>
  :root {{
    --bg: #ffffff;
    --surface: #f6f8fa;
    --border: #d0d7de;
    --fg: #1f2328;
    --muted: #656d76;
    --accent: #0969da;
    --code-bg: #f3f4f6;
    --pill-bg: rgba(255,255,255,0.92);
    --pill-active: #1f2328;
    --pill-active-fg: #ffffff;
    --json-key: #0550ae;
    --json-str: #0a3069;
    --json-num: #116329;
    --json-bool: #8250df;
  }}
  html[data-theme="dark"] {{
    --bg: #141619;
    --surface: #1c1f24;
    --border: #2d323b;
    --fg: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --code-bg: #1f242c;
    --pill-bg: rgba(28,31,36,0.92);
    --pill-active: #e6edf3;
    --pill-active-fg: #141619;
    --json-key: #79c0ff;
    --json-str: #a5d6ff;
    --json-num: #7ee787;
    --json-bool: #d2a8ff;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Geist", sans-serif;
    padding: 0 0 84px 0;
  }}
  .meta-bar {{
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
  }}
  .meta-path {{
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 11px;
  }}
  .meta-tag {{
    flex: none;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--code-bg);
    border: 1px solid var(--border);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }}
  .err {{
    margin: 16px;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
  }}
  .md-body {{
    max-width: 820px;
    margin: 0 auto;
    padding: 20px 24px;
    word-wrap: break-word;
  }}
  .md-body h1, .md-body h2, .md-body h3, .md-body h4 {{
    margin: 1.3em 0 0.55em;
    line-height: 1.25;
    font-weight: 650;
  }}
  .md-body h1 {{ font-size: 1.85em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }}
  .md-body h2 {{ font-size: 1.45em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); }}
  .md-body h3 {{ font-size: 1.2em; }}
  .md-body p {{ margin: 0.7em 0; }}
  .md-body a {{ color: var(--accent); text-decoration: none; }}
  .md-body a:hover {{ text-decoration: underline; }}
  .md-body code {{
    font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 0.88em;
    background: var(--code-bg);
    padding: 2px 5px;
    border-radius: 5px;
  }}
  .md-body pre {{
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow-x: auto;
    margin: 12px 0;
  }}
  .md-body pre code {{
    background: transparent;
    padding: 0;
    font-size: 12.5px;
    line-height: 1.55;
  }}
  .md-body blockquote {{
    margin: 10px 0;
    padding: 4px 14px;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }}
  .md-body ul, .md-body ol {{ padding-left: 22px; margin: 8px 0; }}
  .md-body li {{ margin: 3px 0; }}
  .md-body hr {{ border: 0; border-top: 1px solid var(--border); margin: 18px 0; }}
  .md-body table {{
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
    font-size: 13px;
  }}
  .md-body th, .md-body td {{
    border: 1px solid var(--border);
    padding: 6px 10px;
    text-align: left;
  }}
  .md-body th {{ background: var(--surface); font-weight: 600; }}
  .md-body img {{
    max-width: 100%;
    border-radius: 6px;
    cursor: zoom-in;
    transition: opacity 0.12s;
  }}
  .md-body img:hover {{ opacity: 0.92; }}
  .img-view-wrap {{
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: calc(100vh - 120px);
    padding: 20px;
  }}
  .img-view-card {{
    position: relative;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background-color: var(--surface);
    background-image: radial-gradient(var(--border) 1px, transparent 1px);
    background-size: 16px 16px;
    max-width: 100%;
  }}
  .img-view-card img {{
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 180px);
    border-radius: 6px;
    cursor: zoom-in;
  }}
  .mm-canvas img {{
    display: block;
    max-width: none !important;
    user-select: none;
    -webkit-user-drag: none;
  }}
  .office-loading {{
    padding: 40px 20px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
  }}
  .sheet-wrap {{
    overflow: auto;
    max-height: calc(100vh - 110px);
    padding: 0 0 24px 0;
  }}
  .sheet-table {{
    border-collapse: collapse;
    font-size: 12.5px;
    min-width: 100%;
  }}
  .sheet-table th, .sheet-table td {{
    border: 1px solid var(--border);
    padding: 5px 10px;
    text-align: left;
    white-space: nowrap;
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
  }}
  .sheet-table th {{
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--surface);
    font-weight: 600;
    color: var(--fg);
  }}
  .sheet-table .row-num {{
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--surface);
    color: var(--muted);
    text-align: right;
    width: 42px;
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 11px;
    user-select: none;
  }}
  .sheet-table tr:hover td:not(.row-num) {{
    background: var(--surface);
  }}
  .pptx-list {{
    max-width: 880px;
    margin: 0 auto;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }}
  .slide-card {{
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    overflow: hidden;
    box-shadow: 0 2px 10px rgba(0,0,0,0.06);
  }}
  .slide-head {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    background: var(--bg);
  }}
  .slide-body {{
    padding: 20px 24px;
    min-height: 220px;
  }}
  .slide-body h2 {{
    margin: 0 0 12px 0;
    font-size: 1.35em;
    line-height: 1.3;
  }}
  .slide-body p {{ margin: 6px 0; }}
  .slide-body ul {{ margin: 8px 0; padding-left: 20px; }}
  .slide-body li {{ margin: 4px 0; }}
  .slide-body table {{
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
    font-size: 12.5px;
  }}
  .slide-body th, .slide-body td {{
    border: 1px solid var(--border);
    padding: 6px 10px;
    text-align: left;
  }}
  .slide-media {{
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
  }}
  .slide-media img {{
    max-width: 100%;
    max-height: 300px;
    border-radius: 6px;
    border: 1px solid var(--border);
    cursor: zoom-in;
  }}
  .slide-deck-wrap {{
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: calc(100vh - 120px);
    padding: 24px;
  }}
  .slide-deck-wrap .slide-card {{
    width: 100%;
    max-width: 960px;
  }}
  .floating-bar {{
    max-width: calc(100vw - 24px);
    overflow-x: auto;
  }}
  .mermaid-wrap {{
    position: relative;
    margin: 14px 0;
    padding: 36px 16px 16px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow-x: auto;
    text-align: center;
  }}
  .mermaid-wrap svg {{
    max-width: 100%;
    height: auto;
  }}
  .mermaid-expand-btn {{
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 5;
    border: 1px solid var(--border);
    background: var(--pill-bg);
    color: var(--muted);
    font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 5px 9px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }}
  .mermaid-expand-btn:hover {{
    background: var(--pill-active);
    color: var(--pill-active-fg);
    border-color: var(--pill-active);
  }}
  .mm-modal {{
    position: fixed;
    inset: 0;
    z-index: 200;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }}
  .mm-stage {{
    flex: 1;
    position: relative;
    overflow: hidden;
    cursor: grab;
    user-select: none;
    background-image: radial-gradient(var(--border) 1px, transparent 1px);
    background-size: 20px 20px;
  }}
  .mm-stage.dragging {{ cursor: grabbing; }}
  .mm-canvas {{
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    will-change: transform;
  }}
  .mm-canvas svg {{
    display: block;
    max-width: none !important;
    height: auto;
  }}
  .mm-controls {{
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 210;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px;
    border-radius: 999px;
    background: var(--pill-bg);
    border: 1px solid var(--border);
    box-shadow: 0 8px 28px rgba(0,0,0,0.22);
    backdrop-filter: blur(10px);
  }}
  .mm-controls button {{
    border: 0;
    background: transparent;
    color: var(--fg);
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 7px 11px;
    border-radius: 999px;
    cursor: pointer;
  }}
  .mm-controls button:hover {{
    background: var(--code-bg);
  }}
  .mm-zoom-label {{
    min-width: 48px;
    text-align: center;
    font: 600 11px/1 "JetBrains Mono", Consolas, monospace;
    color: var(--muted);
  }}
  .mm-hint {{
    position: fixed;
    top: 12px;
    left: 16px;
    z-index: 210;
    padding: 5px 10px;
    border-radius: 999px;
    background: var(--pill-bg);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 11px;
  }}
  .mm-close-top {{
    position: fixed;
    top: 12px;
    right: 16px;
    z-index: 210;
    border: 1px solid var(--border);
    background: var(--pill-bg);
    color: var(--fg);
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 7px 12px;
    border-radius: 999px;
    cursor: pointer;
  }}
  .mm-close-top:hover {{
    background: var(--pill-active);
    color: var(--pill-active-fg);
  }}
  .raw-wrap {{
    padding: 14px 0;
    font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.55;
    overflow-x: auto;
  }}
  .raw-wrap.wrap-on .line-text {{ white-space: pre-wrap; word-break: break-word; }}
  .raw-wrap.wrap-off .line-text {{ white-space: pre; }}
  .code-line {{
    display: flex;
    padding: 0 16px 0 0;
  }}
  .line-no {{
    flex: none;
    width: 52px;
    padding-right: 14px;
    text-align: right;
    color: var(--muted);
    user-select: none;
    opacity: 0.7;
  }}
  .line-text {{ flex: 1; min-width: 0; }}
  .json-body {{
    padding: 16px 20px;
    font-family: "JetBrains Mono", "Cascadia Code", Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }}
  .jk {{ color: var(--json-key); }}
  .js {{ color: var(--json-str); }}
  .jn {{ color: var(--json-num); }}
  .jb {{ color: var(--json-bool); }}
  .floating-bar {{
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 999px;
    background: var(--pill-bg);
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0,0,0,0.16);
    backdrop-filter: blur(10px);
  }}
  .floating-bar button {{
    border: 0;
    background: transparent;
    color: var(--muted);
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 7px 14px;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }}
  .floating-bar button:hover {{ color: var(--fg); }}
  .floating-bar button.active {{
    background: var(--pill-active);
    color: var(--pill-active-fg);
  }}
  .floating-bar .sep {{
    width: 1px;
    height: 16px;
    background: var(--border);
    margin: 0 2px;
  }}
</style>
</head>
<body>
<div class="meta-bar">
  <div class="meta-path" id="meta-path"></div>
  <div class="meta-tag" id="meta-tag"></div>
</div>
<div id="err-box"></div>
<main id="view-root"></main>
<div class="floating-bar" id="floating-bar"></div>
<script>
const DATA = {payload};
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
const theme = DATA.theme === 'dark' || (DATA.theme !== 'light' && prefersDark) ? 'dark' : 'light';
document.documentElement.setAttribute('data-theme', theme);
document.getElementById('meta-path').textContent = DATA.path || DATA.name;
document.getElementById('meta-tag').textContent = (DATA.ext || DATA.mode || 'file').toUpperCase();

if (DATA.error) {{
  const d = document.createElement('div');
  d.className = 'err';
  d.textContent = DATA.error;
  document.getElementById('err-box').appendChild(d);
}}

function esc(s) {{
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}}

function inlineMd(s) {{
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
  out = out.replace(/~~(.+?)~~/g, '<del>$1</del>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}}

function renderMarkdown(md) {{
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {{
    const line = lines[i];
    if (/^```/.test(line.trim())) {{
      const lang = line.trim().slice(3).trim().toLowerCase();
      const fence = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {{
        fence.push(lines[i]);
        i++;
      }}
      i++;
      const codeText = fence.join('\n');
      if (lang === 'mermaid') {{
        html += '<div class="mermaid-wrap"><div class="mermaid">' + esc(codeText) + '</div></div>';
      }} else {{
        html += '<pre><code>' + esc(codeText) + '</code></pre>';
      }}
      continue;
    }}
    if (/^\s*([-*_])\1{{2,}}\s*$/.test(line)) {{
      html += '<hr />';
      i++;
      continue;
    }}
    const hm = line.match(/^(#{{1,6}})\s+(.*)$/);
    if (hm) {{
      const lvl = hm[1].length;
      html += `<h${{lvl}}>${{inlineMd(hm[2])}}</h${{lvl}}>`;
      i++;
      continue;
    }}
    if (/^>\s?/.test(line)) {{
      const bq = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {{
        bq.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }}
      html += '<blockquote>' + renderMarkdown(bq.join('\n')) + '</blockquote>';
      continue;
    }}
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {{
      const splitRow = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {{
        rows.push(splitRow(lines[i]));
        i++;
      }}
      html += '<table><thead><tr>' + headers.map(h => `<th>${{inlineMd(h)}}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) {{
        html += '<tr>' + headers.map((_, idx) => `<td>${{inlineMd(r[idx] || '')}}</td>`).join('') + '</tr>';
      }}
      html += '</tbody></table>';
      continue;
    }}
    if (/^\s*[-*+]\s+/.test(line)) {{
      html += '<ul>';
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {{
        let item = lines[i].replace(/^\s*[-*+]\s+/, '');
        if (/^\[x\]\s+/i.test(item)) item = '<input type="checkbox" checked disabled /> ' + inlineMd(item.slice(4));
        else if (/^\[ \]\s+/.test(item)) item = '<input type="checkbox" disabled /> ' + inlineMd(item.slice(4));
        else item = inlineMd(item);
        html += `<li>${{item}}</li>`;
        i++;
      }}
      html += '</ul>';
      continue;
    }}
    if (/^\s*\d+\.\s+/.test(line)) {{
      html += '<ol>';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {{
        html += `<li>${{inlineMd(lines[i].replace(/^\s*\d+\.\s+/, ''))}}</li>`;
        i++;
      }}
      html += '</ol>';
      continue;
    }}
    if (line.trim() === '') {{
      i++;
      continue;
    }}
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{{1,6}}\s|```|>\s?|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i])) {{
      para.push(lines[i]);
      i++;
    }}
    html += `<p>${{inlineMd(para.join(' '))}}</p>`;
  }}
  return html;
}}

function renderRaw(text, wrap) {{
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const wrapDiv = document.createElement('div');
  wrapDiv.className = 'raw-wrap ' + (wrap ? 'wrap-on' : 'wrap-off');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {{
    const row = document.createElement('div');
    row.className = 'code-line';
    const no = document.createElement('span');
    no.className = 'line-no';
    no.textContent = String(i + 1);
    const txt = document.createElement('span');
    txt.className = 'line-text';
    txt.textContent = lines[i];
    row.appendChild(no);
    row.appendChild(txt);
    frag.appendChild(row);
  }}
  wrapDiv.appendChild(frag);
  return wrapDiv;
}}

function highlightJson(pretty) {{
  return esc(pretty).replace(/(&quot;(?:\\u[a-zA-Z0-9]{{4}}|\\[^u]|[^\\&])*?&quot;(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (m) => {{
    if (/^&quot;/.test(m)) {{
      return /:$/.test(m) ? `<span class="jk">${{m}}</span>` : `<span class="js">${{m}}</span>`;
    }}
    if (/^(true|false|null)$/.test(m)) return `<span class="jb">${{m}}</span>`;
    return `<span class="jn">${{m}}</span>`;
  }});
}}

const root = document.getElementById('view-root');
const bar = document.getElementById('floating-bar');
let state = {{ view: DATA.mode === 'text' ? 'raw' : 'preview', wrap: true }};

const scriptCache = {{}};
function loadScript(key, urls, globalCheck) {{
  if (globalCheck()) return Promise.resolve(globalCheck());
  if (scriptCache[key]) return scriptCache[key];
  scriptCache[key] = new Promise((resolve, reject) => {{
    let idx = 0;
    const tryNext = () => {{
      if (idx >= urls.length) return reject(new Error(key + ' load failed'));
      const s = document.createElement('script');
      s.src = urls[idx++];
      s.onload = () => resolve(globalCheck());
      s.onerror = tryNext;
      document.head.appendChild(s);
    }};
    tryNext();
  }});
  return scriptCache[key];
}}

function loadMermaid() {{
  return loadScript('mermaid', [
    'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js',
    'https://unpkg.com/mermaid@11/dist/mermaid.min.js'
  ], () => window.mermaid);
}}

function loadMammoth() {{
  return loadScript('mammoth', [
    'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
    'https://unpkg.com/mammoth@1.8.0/mammoth.browser.min.js'
  ], () => window.mammoth);
}}

function loadXlsx() {{
  return loadScript('xlsx', [
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
  ], () => window.XLSX);
}}

function loadJsZip() {{
  return loadScript('jszip', [
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
  ], () => window.JSZip);
}}

async function renderDocxView() {{
  root.innerHTML = '<div class="office-loading">Loading Word document…</div>';
  try {{
    const [mammoth, resp] = await Promise.all([
      loadMammoth(),
      fetch('/raw?path=' + encodeURIComponent(DATA.path))
    ]);
    if (!resp.ok) throw new Error('Failed to load .docx file');
    const buf = await resp.arrayBuffer();
    const res = await mammoth.convertToHtml({{ arrayBuffer: buf }});
    const art = document.createElement('article');
    art.className = 'md-body';
    art.innerHTML = res.value || '<p><em>Empty document</em></p>';
    root.innerHTML = '';
    root.appendChild(art);
    wireMarkdownImages();
    bar.innerHTML = '';
    addBtn('DOCX Preview', true, () => {{}});
    const sep = document.createElement('div'); sep.className = 'sep'; bar.appendChild(sep);
    const copyBtn = addBtn('Copy Text', false, () => {{
      navigator.clipboard?.writeText(art.innerText || '').then(() => {{
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {{ copyBtn.textContent = 'Copy Text'; }}, 1200);
      }});
    }});
  }} catch (e) {{
    root.innerHTML = `<div class="err">DOCX preview failed: ${{esc(e.message || e)}}</div>`;
  }}
}}

let cachedWorkbook = null;
let activeSheetIdx = 0;

function drawSheetTable(rows) {{
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  const tbl = document.createElement('table');
  tbl.className = 'sheet-table';
  const maxCols = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
  if (!rows.length || !maxCols) {{
    wrap.innerHTML = '<div class="office-loading">Empty sheet</div>';
    return wrap;
  }}
  const colName = (n) => {{
    let s = '';
    let x = n;
    while (x >= 0) {{
      s = String.fromCharCode((x % 26) + 65) + s;
      x = Math.floor(x / 26) - 1;
    }}
    return s;
  }};
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'row-num';
  corner.textContent = '#';
  htr.appendChild(corner);
  for (let c = 0; c < maxCols; c++) {{
    const th = document.createElement('th');
    th.textContent = colName(c);
    htr.appendChild(th);
  }}
  thead.appendChild(htr);
  tbl.appendChild(thead);

  const tbody = document.createElement('tbody');
  const limit = Math.min(rows.length, 2000);
  for (let r = 0; r < limit; r++) {{
    const tr = document.createElement('tr');
    const rn = document.createElement('td');
    rn.className = 'row-num';
    rn.textContent = String(r + 1);
    tr.appendChild(rn);
    const row = rows[r] || [];
    for (let c = 0; c < maxCols; c++) {{
      const td = document.createElement('td');
      const val = row[c] === undefined || row[c] === null ? '' : String(row[c]);
      td.textContent = val;
      if (val.length > 36) td.title = val;
      tr.appendChild(td);
    }}
    tbody.appendChild(tr);
  }}
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}}

async function renderExcelOrCsvView() {{
  if (DATA.mode === 'csv' && state.view === 'raw') {{
    root.innerHTML = '';
    root.appendChild(renderRaw(DATA.content, state.wrap));
    bar.innerHTML = '';
    addBtn('Table', false, () => {{ state.view = 'preview'; renderExcelOrCsvView(); }});
    addBtn('Raw', true, () => {{}});
    return;
  }}
  if (!cachedWorkbook) {{
    root.innerHTML = '<div class="office-loading">Loading spreadsheet…</div>';
    try {{
      const XLSX = await loadXlsx();
      if (DATA.mode === 'csv') {{
        cachedWorkbook = XLSX.read(DATA.content, {{ type: 'string' }});
      }} else {{
        const resp = await fetch('/raw?path=' + encodeURIComponent(DATA.path));
        if (!resp.ok) throw new Error('Failed to load spreadsheet');
        const buf = await resp.arrayBuffer();
        cachedWorkbook = XLSX.read(buf, {{ type: 'array' }});
      }}
    }} catch (e) {{
      root.innerHTML = `<div class="err">Spreadsheet preview failed: ${{esc(e.message || e)}}</div>`;
      return;
    }}
  }}
  const names = cachedWorkbook.SheetNames || [];
  if (activeSheetIdx >= names.length) activeSheetIdx = 0;
  const sheet = cachedWorkbook.Sheets[names[activeSheetIdx]];
  const rows = window.XLSX.utils.sheet_to_json(sheet, {{ header: 1, defval: '' }});
  root.innerHTML = '';
  root.appendChild(drawSheetTable(rows));

  bar.innerHTML = '';
  if (DATA.mode === 'csv') {{
    addBtn('Table', true, () => {{}});
    addBtn('Raw', false, () => {{ state.view = 'raw'; renderExcelOrCsvView(); }});
  }} else {{
    names.forEach((name, idx) => {{
      addBtn(name, idx === activeSheetIdx, () => {{
        activeSheetIdx = idx;
        renderExcelOrCsvView();
      }});
    }});
  }}
  const sep = document.createElement('div'); sep.className = 'sep'; bar.appendChild(sep);
  const copyBtn = addBtn('Copy TSV', false, () => {{
    const tsv = rows.map(r => (r || []).map(v => String(v ?? '')).join('\t')).join('\n');
    navigator.clipboard?.writeText(tsv).then(() => {{
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {{ copyBtn.textContent = 'Copy TSV'; }}, 1200);
    }});
  }});
}}

let cachedSlides = null;
let pptxMode = 'scroll';
let pptxIdx = 0;
let pptxFullscreen = false;

function buildSlideCard(slide, total) {{
  const card = document.createElement('section');
  card.className = 'slide-card';
  const head = document.createElement('div');
  head.className = 'slide-head';
  head.innerHTML = `<span>Slide ${{slide.num}} / ${{total}}</span><span>${{esc(slide.title || '')}}</span>`;
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'slide-body';
  if (slide.title) {{
    const h2 = document.createElement('h2');
    h2.textContent = slide.title;
    body.appendChild(h2);
  }}
  if (slide.paragraphs.length) {{
    const ul = document.createElement('ul');
    for (const p of slide.paragraphs) {{
      const li = document.createElement('li');
      li.textContent = p;
      ul.appendChild(li);
    }}
    body.appendChild(ul);
  }}
  for (const tblRows of slide.tables) {{
    const tbl = document.createElement('table');
    tblRows.forEach((r, ri) => {{
      const tr = document.createElement('tr');
      r.forEach((c) => {{
        const cell = document.createElement(ri === 0 ? 'th' : 'td');
        cell.textContent = c;
        tr.appendChild(cell);
      }});
      tbl.appendChild(tr);
    }});
    body.appendChild(tbl);
  }}
  if (slide.images.length) {{
    const mwrap = document.createElement('div');
    mwrap.className = 'slide-media';
    for (const src of slide.images) {{
      const img = document.createElement('img');
      img.src = src;
      img.title = 'Click to open fullscreen zoom/pan viewer';
      img.onclick = () => openLightbox({{ kind: 'image', imgSrc: src }});
      mwrap.appendChild(img);
    }}
    body.appendChild(mwrap);
  }}
  if (!slide.title && !slide.paragraphs.length && !slide.tables.length && !slide.images.length) {{
    body.innerHTML = '<p style="color:var(--muted)"><em>Empty slide</em></p>';
  }}
  card.appendChild(body);
  return card;
}}

async function renderPptxView() {{
  if (!cachedSlides) {{
    root.innerHTML = '<div class="office-loading">Loading presentation…</div>';
    try {{
      const [JSZip, resp] = await Promise.all([
        loadJsZip(),
        fetch('/raw?path=' + encodeURIComponent(DATA.path))
      ]);
      if (!resp.ok) throw new Error('Failed to load .pptx file');
      const buf = await resp.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);

      const slideFiles = Object.keys(zip.files)
        .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
        .sort((a, b) => {{
          const na = parseInt(a.match(/slide(\d+)\.xml/i)[1], 10);
          const nb = parseInt(b.match(/slide(\d+)\.xml/i)[1], 10);
          return na - nb;
        }});

      const parser = new DOMParser();
      const slides = [];
      for (let i = 0; i < slideFiles.length; i++) {{
        const sf = slideFiles[i];
        const xmlStr = await zip.file(sf).async('string');
        const doc = parser.parseFromString(xmlStr, 'application/xml');
        const num = i + 1;
        let title = '';
        const paragraphs = [];
        const tables = [];

        const spList = doc.getElementsByTagName('p:sp');
        for (const sp of spList) {{
          const ph = sp.getElementsByTagName('p:ph')[0];
          const phType = ph ? (ph.getAttribute('type') || '') : '';
          const isTitle = phType === 'title' || phType === 'ctrTitle';
          const pNodes = sp.getElementsByTagName('a:p');
          for (const p of pNodes) {{
            const tNodes = p.getElementsByTagName('a:t');
            let line = '';
            for (const t of tNodes) line += t.textContent || '';
            line = line.trim();
            if (!line) continue;
            if (isTitle && !title) title = line;
            else paragraphs.push(line);
          }}
        }}

        const tblNodes = doc.getElementsByTagName('a:tbl');
        for (const tbl of tblNodes) {{
          const rows = [];
          const trNodes = tbl.getElementsByTagName('a:tr');
          for (const tr of trNodes) {{
            const cells = [];
            const tcNodes = tr.getElementsByTagName('a:tc');
            for (const tc of tcNodes) {{
              let txt = '';
              for (const t of tc.getElementsByTagName('a:t')) txt += (t.textContent || '') + ' ';
              cells.push(txt.trim());
            }}
            rows.push(cells);
          }}
          if (rows.length) tables.push(rows);
        }}

        const images = [];
        const relPath = sf.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
        if (zip.file(relPath)) {{
          const relXml = await zip.file(relPath).async('string');
          const relDoc = parser.parseFromString(relXml, 'application/xml');
          const rels = relDoc.getElementsByTagName('Relationship');
          for (const rel of rels) {{
            const target = rel.getAttribute('Target') || '';
            if (/\.(png|jpe?g|gif|webp|svg)$/i.test(target)) {{
              const mediaPath = target.startsWith('../')
                ? 'ppt/' + target.slice(3)
                : 'ppt/slides/' + target;
              const f = zip.file(mediaPath);
              if (f) {{
                const blob = await f.async('blob');
                images.push(URL.createObjectURL(blob));
              }}
            }}
          }}
        }}

        slides.push({{ num, title, paragraphs, tables, images }});
      }}
      cachedSlides = slides;
    }} catch (e) {{
      root.innerHTML = `<div class="err">PPTX preview failed: ${{esc(e.message || e)}}</div>`;
      return;
    }}
  }}

  root.innerHTML = '';
  bar.innerHTML = '';
  const total = cachedSlides.length;
  if (!total) {{
    root.innerHTML = '<div class="office-loading">No slides found</div>';
    return;
  }}

  if (pptxMode === 'deck') {{
    if (pptxIdx < 0) pptxIdx = 0;
    if (pptxIdx >= total) pptxIdx = total - 1;
    const wrap = document.createElement('div');
    wrap.className = 'slide-deck-wrap';
    wrap.appendChild(buildSlideCard(cachedSlides[pptxIdx], total));
    root.appendChild(wrap);
  }} else {{
    const list = document.createElement('div');
    list.className = 'pptx-list';
    for (const s of cachedSlides) list.appendChild(buildSlideCard(s, total));
    root.appendChild(list);
  }}

  addBtn('Scroll', pptxMode === 'scroll', () => {{ pptxMode = 'scroll'; renderPptxView(); }});
  addBtn('Deck', pptxMode === 'deck', () => {{ pptxMode = 'deck'; renderPptxView(); }});
  if (pptxMode === 'deck') {{
    const sep1 = document.createElement('div'); sep1.className = 'sep'; bar.appendChild(sep1);
    addBtn('←', false, () => {{ if (pptxIdx > 0) {{ pptxIdx--; renderPptxView(); }} }});
    addBtn(`${{pptxIdx + 1}} / ${{total}}`, false, () => {{}});
    addBtn('→', false, () => {{ if (pptxIdx < total - 1) {{ pptxIdx++; renderPptxView(); }} }});
  }}
  const sep2 = document.createElement('div'); sep2.className = 'sep'; bar.appendChild(sep2);
  addBtn(pptxFullscreen ? '✕ Exit Fullscreen' : '⤢ Fullscreen', pptxFullscreen, () => {{
    pptxFullscreen = !pptxFullscreen;
    setHostFullscreen(pptxFullscreen);
    renderPptxView();
  }});
}}

window.addEventListener('keydown', (e) => {{
  if (DATA.mode !== 'pptx') return;
  if (e.key === 'Escape' && pptxFullscreen) {{
    pptxFullscreen = false;
    setHostFullscreen(false);
    renderPptxView();
  }} else if (pptxMode === 'deck' && e.key === 'ArrowRight' && cachedSlides && pptxIdx < cachedSlides.length - 1) {{
    pptxIdx++;
    renderPptxView();
  }} else if (pptxMode === 'deck' && e.key === 'ArrowLeft' && pptxIdx > 0) {{
    pptxIdx--;
    renderPptxView();
  }}
}});

function resolveLocalImgSrc(src) {{
  if (!src) return src;
  if (/^(https?:|data:|blob:|\/raw\?)/i.test(src)) return src;
  if (/^file:\/\//i.test(src)) {{
    let p = decodeURIComponent(src.replace(/^file:\/+/i, ''));
    if (/^[A-Za-z]:/.test(p)) p = p.replace(/\//g, '\\');
    return '/raw?path=' + encodeURIComponent(p);
  }}
  if (/^[A-Za-z]:[\\/]/.test(src)) {{
    return '/raw?path=' + encodeURIComponent(src);
  }}
  if (DATA.baseDir) {{
    const sep = DATA.baseDir.includes('\\') ? '\\' : '/';
    const joined = DATA.baseDir.replace(/[\\/]+$/, '') + sep + src.replace(/^\.[\\/]/, '');
    return '/raw?path=' + encodeURIComponent(joined);
  }}
  return src;
}}

function setHostFullscreen(active) {{
  return fetch('/fullscreen', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify({{ active: Boolean(active) }})
  }}).catch(() => {{}});
}}

function openLightbox(opts) {{
  const {{ kind, svgEl, imgSrc }} = opts || {{}};
  if (kind === 'svg' && !svgEl) return;
  if (kind === 'image' && !imgSrc) return;

  setHostFullscreen(true);

  const modal = document.createElement('div');
  modal.className = 'mm-modal';

  const hint = document.createElement('div');
  hint.className = 'mm-hint';
  hint.textContent = 'Scroll to zoom · Drag to pan · Double-click to reset · Esc to close';

  const closeTop = document.createElement('button');
  closeTop.className = 'mm-close-top';
  closeTop.textContent = '✕ Close';

  const stage = document.createElement('div');
  stage.className = 'mm-stage';

  const canvas = document.createElement('div');
  canvas.className = 'mm-canvas';

  let baseW = 800;
  let baseH = 500;

  if (kind === 'svg') {{
    const clone = svgEl.cloneNode(true);
    clone.removeAttribute('style');
    const vb = clone.getAttribute('viewBox');
    baseW = svgEl.getBoundingClientRect().width || 800;
    baseH = svgEl.getBoundingClientRect().height || 500;
    if (vb) {{
      const p = vb.split(/[\s,]+/).map(Number);
      if (p.length === 4 && p[2] > 0 && p[3] > 0) {{
        baseW = p[2];
        baseH = p[3];
        clone.setAttribute('width', String(baseW));
        clone.setAttribute('height', String(baseH));
      }}
    }}
    canvas.appendChild(clone);
  }} else {{
    const img = document.createElement('img');
    img.src = imgSrc;
    img.onload = () => {{
      baseW = img.naturalWidth || img.width || 800;
      baseH = img.naturalHeight || img.height || 500;
      fitToStage();
    }};
    canvas.appendChild(img);
  }}
  stage.appendChild(canvas);

  const controls = document.createElement('div');
  controls.className = 'mm-controls';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'mm-zoom-label';

  let scale = 1;
  let tx = 0;
  let ty = 0;

  function applyTransform() {{
    canvas.style.transform = `translate(${{tx}}px, ${{ty}}px) scale(${{scale}})`;
    zoomLabel.textContent = `${{Math.round(scale * 100)}}%`;
  }}

  function fitToStage() {{
    const r = stage.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const pad = 56;
    const sx = (r.width - pad * 2) / Math.max(baseW, 1);
    const sy = (r.height - pad * 2) / Math.max(baseH, 1);
    scale = Math.min(Math.max(Math.min(sx, sy), 0.1), 2.5);
    tx = (r.width - baseW * scale) / 2;
    ty = (r.height - baseH * scale) / 2;
    applyTransform();
  }}

  function zoomAt(factor, cx, cy) {{
    const next = Math.min(Math.max(scale * factor, 0.1), 16);
    const ratio = next / scale;
    tx = cx - (cx - tx) * ratio;
    ty = cy - (cy - ty) * ratio;
    scale = next;
    applyTransform();
  }}

  const mkCtrl = (label, fn) => {{
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    return b;
  }};

  controls.appendChild(mkCtrl('−', () => {{
    const r = stage.getBoundingClientRect();
    zoomAt(0.8, r.width / 2, r.height / 2);
  }}));
  controls.appendChild(zoomLabel);
  controls.appendChild(mkCtrl('+', () => {{
    const r = stage.getBoundingClientRect();
    zoomAt(1.25, r.width / 2, r.height / 2);
  }}));
  controls.appendChild(mkCtrl('Fit', fitToStage));
  controls.appendChild(mkCtrl('100%', () => {{
    const r = stage.getBoundingClientRect();
    scale = 1;
    tx = (r.width - baseW) / 2;
    ty = (r.height - baseH) / 2;
    applyTransform();
  }}));

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startTx = 0;
  let startTy = 0;

  stage.addEventListener('pointerdown', (e) => {{
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startTx = tx;
    startTy = ty;
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
  }});
  stage.addEventListener('pointermove', (e) => {{
    if (!dragging) return;
    tx = startTx + (e.clientX - startX);
    ty = startTy + (e.clientY - startY);
    applyTransform();
  }});
  const endDrag = () => {{
    dragging = false;
    stage.classList.remove('dragging');
  }};
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('wheel', (e) => {{
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
    zoomAt(factor, cx, cy);
  }}, {{ passive: false }});

  stage.addEventListener('dblclick', fitToStage);

  let resizeTimer = null;
  const onResize = () => {{
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitToStage, 40);
  }};

  const close = () => {{
    clearTimeout(resizeTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    modal.remove();
    setHostFullscreen(false);
  }};
  const onKey = (e) => {{
    if (e.key === 'Escape') close();
    else if (e.key === '+' || e.key === '=') {{
      const r = stage.getBoundingClientRect();
      zoomAt(1.2, r.width / 2, r.height / 2);
    }} else if (e.key === '-') {{
      const r = stage.getBoundingClientRect();
      zoomAt(0.83, r.width / 2, r.height / 2);
    }} else if (e.key === '0') {{
      fitToStage();
    }}
  }};
  closeTop.onclick = close;
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  modal.appendChild(stage);
  modal.appendChild(hint);
  modal.appendChild(closeTop);
  modal.appendChild(controls);
  document.body.appendChild(modal);
  requestAnimationFrame(fitToStage);
  setTimeout(fitToStage, 120);
}}

function wireMarkdownImages() {{
  root.querySelectorAll('.md-body img').forEach((img) => {{
    const rawSrc = img.getAttribute('src');
    if (rawSrc) {{
      img.src = resolveLocalImgSrc(rawSrc);
    }}
    img.title = 'Click to open fullscreen zoom/pan viewer';
    img.onclick = () => openLightbox({{ kind: 'image', imgSrc: img.src }});
  }});
}}

function renderMermaidDiagrams() {{
  const nodes = root.querySelectorAll('.mermaid');
  if (!nodes.length) return;
  loadMermaid().then((m) => {{
    if (!m) return;
    m.initialize({{
      startOnLoad: false,
      theme: theme === 'dark' ? 'dark' : 'default',
      securityLevel: 'strict',
      flowchart: {{ htmlLabels: true, curve: 'basis' }}
    }});
    m.run({{ nodes }}).then(() => {{
      root.querySelectorAll('.mermaid-wrap').forEach((wrap) => {{
        if (wrap.querySelector('.mermaid-expand-btn')) return;
        const svgEl = wrap.querySelector('svg');
        if (!svgEl) return;
        const btn = document.createElement('button');
        btn.className = 'mermaid-expand-btn';
        btn.textContent = '⤢ Fullscreen';
        btn.onclick = () => openLightbox({{ kind: 'svg', svgEl }});
        wrap.appendChild(btn);
      }});
    }}).catch(() => {{}});
  }}).catch(() => {{}});
}}

function draw() {{
  root.innerHTML = '';
  bar.innerHTML = '';

  if (DATA.mode === 'docx') {{
    renderDocxView();
    return;
  }}

  if (DATA.mode === 'excel' || DATA.mode === 'csv') {{
    renderExcelOrCsvView();
    return;
  }}

  if (DATA.mode === 'pptx') {{
    renderPptxView();
    return;
  }}

  if (DATA.mode === 'image') {{
    const imgUrl = '/raw?path=' + encodeURIComponent(DATA.path);
    const wrap = document.createElement('div');
    wrap.className = 'img-view-wrap';
    const card = document.createElement('div');
    card.className = 'img-view-card';
    const img = document.createElement('img');
    img.src = imgUrl;
    img.title = 'Click to open fullscreen zoom/pan viewer';
    img.onclick = () => openLightbox({{ kind: 'image', imgSrc: imgUrl }});
    card.appendChild(img);
    wrap.appendChild(card);
    root.appendChild(wrap);
    addBtn('⤢ Fullscreen', true, () => openLightbox({{ kind: 'image', imgSrc: imgUrl }}));
    return;
  }}

  if (DATA.mode === 'markdown') {{
    if (state.view === 'preview') {{
      const d = document.createElement('article');
      d.className = 'md-body';
      d.innerHTML = renderMarkdown(DATA.content);
      root.appendChild(d);
      wireMarkdownImages();
      renderMermaidDiagrams();
    }} else {{
      root.appendChild(renderRaw(DATA.content, state.wrap));
    }}
    addBtn('Preview', state.view === 'preview', () => {{ state.view = 'preview'; draw(); }});
    addBtn('Raw', state.view === 'raw', () => {{ state.view = 'raw'; draw(); }});
  }} else if (DATA.mode === 'json') {{
    if (state.view === 'preview') {{
      const d = document.createElement('pre');
      d.className = 'json-body';
      try {{
        const pretty = JSON.stringify(JSON.parse(DATA.content), null, 2);
        d.innerHTML = highlightJson(pretty);
      }} catch {{
        d.textContent = DATA.content;
      }}
      root.appendChild(d);
    }} else {{
      root.appendChild(renderRaw(DATA.content, state.wrap));
    }}
    addBtn('Formatted', state.view === 'preview', () => {{ state.view = 'preview'; draw(); }});
    addBtn('Raw', state.view === 'raw', () => {{ state.view = 'raw'; draw(); }});
  }} else {{
    root.appendChild(renderRaw(DATA.content, state.wrap));
    addBtn('Wrap', state.wrap, () => {{ state.wrap = true; draw(); }});
    addBtn('No Wrap', !state.wrap, () => {{ state.wrap = false; draw(); }});
  }}

  const sep = document.createElement('div');
  sep.className = 'sep';
  bar.appendChild(sep);
  const copyBtn = addBtn('Copy', false, () => {{
    navigator.clipboard?.writeText(DATA.content).then(() => {{
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {{ copyBtn.textContent = 'Copy'; }}, 1200);
    }});
  }});
}}

function addBtn(label, active, onClick) {{
  const b = document.createElement('button');
  b.textContent = label;
  if (active) b.className = 'active';
  b.onclick = onClick;
  bar.appendChild(b);
  return b;
}}

draw();
</script>
</body>
</html>"#,
        title = title_esc,
        payload = payload
    );
    ("200 OK".to_string(), html)
}

fn handle_http(
    mut stream: TcpStream,
    state: Arc<Mutex<SharedState>>,
    container_hwnd: isize,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut buf = [0u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let raw_path = parts.next().unwrap_or("/");
    let (path, query) = parse_query(raw_path);

    let body = req.split("\r\n\r\n").nth(1).unwrap_or("").trim();

    if method == "GET" && path == "/raw" {
        let file_path = query.get("path").map(|s| s.as_str()).unwrap_or("");
        let path_obj = PathBuf::from(file_path);
        let ext = path_obj
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            _ => "application/octet-stream",
        };
        if let Ok(bytes) = std::fs::read(&path_obj) {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                mime,
                bytes.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&bytes);
        } else {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        return;
    }

    if method == "GET" && path == "/view" {
        let file_path = query.get("path").map(|s| s.as_str()).unwrap_or("");
        let theme_hint = query.get("theme").map(|s| s.as_str()).unwrap_or("auto");
        let (status_line, html_body) = render_artifact_html(file_path, theme_hint);
        let resp = format!(
            "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
            status_line,
            html_body.len(),
            html_body
        );
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    let (status_line, json_body) = match (method, path) {
        ("GET", "/status") => {
            let st = state.lock().unwrap();
            let dpi = unsafe {
                let h = st.herdr_hwnd as HWND;
                if !h.is_null() {
                    GetDpiForWindow(h)
                } else {
                    96
                }
            };
            let active = st.tabs.iter().find(|t| t.id == st.active_tab);
            let resp = StatusResp {
                ok: true,
                pid: std::process::id(),
                active_tab: st.active_tab.clone(),
                url: active.map(|t| t.url.clone()).unwrap_or_default(),
                title: active.map(|t| t.title.clone()).unwrap_or_default(),
                tabs: st.tabs.clone(),
                visible: st.visible,
                herdr_hwnd: st.herdr_hwnd,
                dpi,
                new_ports: st.new_ports.clone(),
                active_ports: st.active_ports.clone(),
            };
            (
                "200 OK",
                serde_json::to_string(&resp).unwrap_or_else(|_| "{}".into()),
            )
        }
        ("POST", "/tabs/open") => {
            #[derive(Deserialize)]
            struct OpenReq {
                id: Option<String>,
                url: Option<String>,
                dedupe: Option<bool>,
            }
            if let Ok(r) = serde_json::from_str::<OpenReq>(body) {
                state.lock().unwrap().queue.push_back(HostCmd::OpenTab {
                    id: r.id,
                    url: r.url.unwrap_or_else(|| "about:blank".into()),
                    dedupe: r.dedupe.unwrap_or(false),
                });
                unsafe {
                    PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
                }
                ("200 OK", "{\"ok\":true}".into())
            } else {
                ("400 Bad Request", "{\"ok\":false}".into())
            }
        }
        ("POST", "/tabs/select") => {
            #[derive(Deserialize)]
            struct SelReq {
                id: String,
            }
            if let Ok(r) = serde_json::from_str::<SelReq>(body) {
                state
                    .lock()
                    .unwrap()
                    .queue
                    .push_back(HostCmd::SelectTab(r.id));
                unsafe {
                    PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
                }
                ("200 OK", "{\"ok\":true}".into())
            } else {
                ("400 Bad Request", "{\"ok\":false}".into())
            }
        }
        ("POST", "/tabs/close") => {
            #[derive(Deserialize)]
            struct CloseReq {
                id: String,
            }
            if let Ok(r) = serde_json::from_str::<CloseReq>(body) {
                state
                    .lock()
                    .unwrap()
                    .queue
                    .push_back(HostCmd::CloseTab(r.id));
                unsafe {
                    PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
                }
                ("200 OK", "{\"ok\":true}".into())
            } else {
                ("400 Bad Request", "{\"ok\":false}".into())
            }
        }
        ("POST", "/navigate") => {
            #[derive(Deserialize)]
            struct Nav {
                id: Option<String>,
                url: String,
            }
            if let Ok(nav) = serde_json::from_str::<Nav>(body) {
                state.lock().unwrap().queue.push_back(HostCmd::Navigate {
                    id: nav.id,
                    url: nav.url,
                });
                unsafe {
                    PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
                }
                ("200 OK", "{\"ok\":true}".into())
            } else {
                (
                    "400 Bad Request",
                    "{\"ok\":false,\"error\":\"invalid json\"}".into(),
                )
            }
        }
        ("POST", "/bounds") => {
            if let Ok(b) = serde_json::from_str::<BoundsReq>(body) {
                state.lock().unwrap().queue.push_back(HostCmd::Bounds(b));
                unsafe {
                    PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
                }
                ("200 OK", "{\"ok\":true}".into())
            } else {
                (
                    "400 Bad Request",
                    "{\"ok\":false,\"error\":\"invalid bounds\"}".into(),
                )
            }
        }
        ("POST", "/ping") => {
            state.lock().unwrap().queue.push_back(HostCmd::Ping);
            unsafe {
                PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
            }
            ("200 OK", "{\"ok\":true}".into())
        }
        ("POST", "/fullscreen") => {
            #[derive(Deserialize)]
            struct FsReq {
                active: bool,
            }
            if let Ok(r) = serde_json::from_str::<FsReq>(body) {
                state
                    .lock()
                    .unwrap()
                    .queue
                    .push_back(HostCmd::Fullscreen(r.active));
                unsafe {
                    PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
                }
                ("200 OK", "{\"ok\":true}".into())
            } else {
                ("400 Bad Request", "{\"ok\":false}".into())
            }
        }
        ("POST", "/back") => {
            state.lock().unwrap().queue.push_back(HostCmd::Back);
            unsafe {
                PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
            }
            ("200 OK", "{\"ok\":true}".into())
        }
        ("POST", "/forward") => {
            state.lock().unwrap().queue.push_back(HostCmd::Forward);
            unsafe {
                PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
            }
            ("200 OK", "{\"ok\":true}".into())
        }
        ("POST", "/reload") => {
            state.lock().unwrap().queue.push_back(HostCmd::Reload);
            unsafe {
                PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
            }
            ("200 OK", "{\"ok\":true}".into())
        }
        ("POST", "/devtools") => {
            state.lock().unwrap().queue.push_back(HostCmd::DevTools);
            unsafe {
                PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
            }
            ("200 OK", "{\"ok\":true}".into())
        }
        ("POST", "/quit") => {
            state.lock().unwrap().queue.push_back(HostCmd::Quit);
            unsafe {
                PostMessageW(container_hwnd as HWND, WM_RUN_CMD, 0, 0);
            }
            ("200 OK", "{\"ok\":true}".into())
        }
        _ => ("404 Not Found", "{\"ok\":false}".into()),
    };

    let resp = format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_line,
        json_body.len(),
        json_body
    );
    let _ = stream.write_all(resp.as_bytes());
}

fn main() {
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
    }

    let args: Vec<String> = std::env::args().collect();
    let mut data_dir = PathBuf::from(".");
    let mut initial_url = String::from("about:blank");
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--data-dir" if i + 1 < args.len() => {
                data_dir = PathBuf::from(&args[i + 1]);
                i += 2;
            }
            "--url" if i + 1 < args.len() => {
                initial_url = args[i + 1].clone();
                i += 2;
            }
            _ => i += 1,
        }
    }

    let _ = std::fs::create_dir_all(&data_dir);
    let log_path = data_dir.join("host.log");
    let log = |msg: &str| {
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| writeln!(f, "{}", msg));
    };
    let _ = std::fs::write(&log_path, "");
    log("starting herdr-webview (multi-tab + port watcher)");

    let profile_dir = data_dir.join("webview2-profile");
    let _ = std::fs::create_dir_all(&profile_dir);

    let herdr_hwnd = match find_herdr_hwnd() {
        Some(h) => {
            log(&format!("found herdr_hwnd={:?}", h));
            h
        }
        None => {
            log(&format!(
                "find_herdr_hwnd returned None, pids={:?}",
                find_herdr_pids()
            ));
            return;
        }
    };

    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    let port = listener.local_addr().unwrap().port();

    let class_name = wide("HerdrWebViewHostClass");
    let container_hwnd = unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: CreateSolidBrush(0x00FFFFFF) as HBRUSH,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc);

        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            wide("Herdr Artifact Viewer").as_ptr(),
            WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            400,
            400,
            herdr_hwnd,
            std::ptr::null_mut(),
            hinst,
            std::ptr::null(),
        )
    };

    if container_hwnd.is_null() {
        log("container_hwnd is null");
        return;
    }
    log(&format!("container_hwnd={:?}", container_hwnd));

    unsafe {
        ShowWindow(container_hwnd, SW_HIDE);
        SetTimer(container_hwnd, TIMER_WATCHDOG, 1000, None);
        SetTimer(container_hwnd, TIMER_SYNC, 30, None);
    }

    let state = Arc::new(Mutex::new(SharedState {
        tabs: Vec::new(),
        active_tab: String::new(),
        visible: false,
        herdr_hwnd: herdr_hwnd as isize,
        new_ports: Vec::new(),
        active_ports: Vec::new(),
        queue: VecDeque::new(),
    }));

    let mut app = Box::new(AppContext {
        state: Arc::clone(&state),
        container_hwnd,
        web_context: WebContext::new(Some(profile_dir)),
        tabs: Vec::new(),
        active_tab: String::new(),
        next_tab_seq: 0,
        last_bounds: None,
        last_applied_rect: None,
        last_visible_ping: Instant::now(),
        currently_shown: false,
        fullscreen: false,
    });

    if let Some(first_id) = create_tab(&mut app, None, &initial_url) {
        select_tab(&mut app, &first_id);
        log(&format!("initial tab built ok: {}", first_id));
    } else {
        log("failed to create initial webview tab");
        unsafe {
            DestroyWindow(container_hwnd);
        }
        return;
    }

    let host_info = serde_json::json!({
        "port": port,
        "pid": std::process::id(),
        "herdr_hwnd": herdr_hwnd as isize
    });
    let _ = std::fs::write(data_dir.join("host.json"), host_info.to_string());

    unsafe {
        APP_PTR = &mut *app;
    }

    spawn_port_watcher(Arc::clone(&state), port);
    spawn_http_server(listener, Arc::clone(&state), container_hwnd as isize);

    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        APP_PTR = std::ptr::null_mut();
    }

    let _ = std::fs::remove_file(data_dir.join("host.json"));
}
