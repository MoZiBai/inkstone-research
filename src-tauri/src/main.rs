// The desktop app is a GUI in both development and release builds. Keeping
// the Windows subsystem on debug builds prevents a separate console window
// from appearing behind the research desk.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    inkstone_lib::run()
}
